import type { PushDiagnosticTrace } from '../util/pushDiagnostics';

import { APP_NAME, DEBUG, DEBUG_MORE } from '../config';
import { isChatHidden } from '../util/hiddenChats';
import { isInternalChat } from '../util/internalChats';
import {
  isAdsPlatformLoginText, isOfficialTelegramServiceChat, JUST_CHAT_TITLE,
} from '../util/officialTelegramAds';
import {
  createPushDiagnosticTrace, flushPushDiagnosticTrace, recordPushDiagnosticStep,
} from '../util/pushDiagnostics';
import { decryptTelegramPush, loadPushSecret } from '../util/telegramPushSecret';
import trimText from '../util/trimText';

declare const self: ServiceWorkerGlobalScope;

enum Boolean {
  True = '1',
  False = '0',
}

type PushData = {
  date?: number;
  custom: {
    msg_id?: string;
    silent?: string;
    channel_id?: string;
    chat_id?: string;
    from_id?: string;
  };
  mute: Boolean;
  badge: Boolean;
  loc_key: string;
  loc_args: string[];
  random_id: number;
  title: string;
  description: string;
};

type NotificationData = {
  messageId?: number;
  chatId?: string;
  title: string;
  body: string;
  isSilent?: boolean;
  icon?: string;
  reaction?: string;
  shouldReplaceHistory?: boolean;
  sentAt?: number;
};

type FocusMessageData = {
  chatId?: string;
  messageId?: number;
  reaction?: string;
  shouldReplaceHistory?: boolean;
};

type CloseNotificationData = {
  lastReadInboxMessageId?: number;
  chatId: string;
};

const APP_NOTIFICATION_TAG = 'justchat';
const MAX_INBOX_CHATS = 8;
const MAX_LINES_PER_CHAT = 5;
const MAX_ROW_LENGTH = 60;
const SECONDS_TO_MS = 1000;
const UNIX_MS_THRESHOLD = 1e12;
const ROW_WHITESPACE_RE = /\s+/g;
const HIDDEN_SERVICE_LOC_KEYS = new Set(['AUTH_UNKNOWN', 'AUTH_REGION', 'DC_UPDATE']);
const EMPTY_WAKE_WAIT_MS = 3000;
const GENERIC_PUSH_DESCRIPTION = 'New message';
const FCM_JSON_FIELD_RE = /^[[{]/;
const PUSH_NOTIFICATION_TYPE_RE = /^[A-Z_0-9]{1,64}$/;
const IS_SAFARI = /applewebkit/i.test(self.navigator.userAgent)
  && !/Chrom(e|ium)\//.test(self.navigator.userAgent);

type InboxEntry = {
  chatId?: string;
  title: string;
  bodies: string[];
  messageId?: number;
  icon?: string;
  reaction?: string;
  isSilent?: boolean;
  shouldReplaceHistory?: boolean;
  sentAt?: number;
};

type AppNotificationOptions = NotificationOptions & {
  timestamp?: number;
};

type NotificationTrace = {
  id: number;
  source: 'push' | 'showMessageNotification' | 'closeMessageNotifications' | 'dismissChatlessNotification';
  diagnostic: PushDiagnosticTrace;
  hasNotificationRequestResolved?: boolean;
  skipReason?: string;
  notificationType?: string;
  notificationTask?: Promise<void>;
};

const inboxByChatKey = new Map<string, InboxEntry>();
const shownNotifications = new Set();
const clickBuffer: Record<string, NotificationData> = {};
let restorePromise: Promise<void> | undefined;
let lastPreviewPushAt = 0;
let lastEmptyWakeShownAt = 0;
let lastNotificationTraceId = 0;

function readPushRaw(event: PushEvent, trace?: NotificationTrace) {
  if (!event.data) return undefined;
  try {
    const text = event.data.text().trim();
    if (!text) return undefined;
    if (text.startsWith('{') || text.startsWith('[')) {
      return JSON.parse(text);
    }
    return text;
  } catch (err) {
    logNotificationTrace(trace, 'payloadReadFailed', err);
    return undefined;
  }
}

function rawToPushData(raw: unknown) {
  if (typeof raw === 'string') {
    return {
      ...buildGenericPushData(),
      description: raw,
    };
  }
  if (raw === undefined) return buildGenericPushData();
  // A payload that stays encrypted as `{ p }` falls back to the generic text
  return normalizePushPayload(raw) || buildGenericPushData();
}

// FCM delivers Telegram's fields inside `data`, each one a string, and often omits `fcmMessageId`
function normalizePushPayload(payload: any): PushData | undefined {
  if (!payload || typeof payload !== 'object') return undefined;

  const source = isFcmEnvelope(payload) ? unwrapFcmData(payload.data) : payload;
  const custom = parseCustom(source.custom) || {};
  if (!custom.from_id && source.from_id) custom.from_id = String(source.from_id);
  if (!custom.chat_id && source.chat_id) custom.chat_id = String(source.chat_id);
  if (!custom.channel_id && source.channel_id) custom.channel_id = String(source.channel_id);
  if (!custom.msg_id && source.msg_id) custom.msg_id = String(source.msg_id);

  const locArgs = parseLocArgs(source.loc_args);
  const notification = payload.notification;
  const title = source.title
    || notification?.title
    || (locArgs.length > 1 ? locArgs[0] : undefined);
  const description = source.description
    || notification?.body
    || locArgs[locArgs.length - 1];
  if (!source.custom && !source.loc_key && !description) return undefined;

  return {
    ...source,
    custom,
    loc_args: locArgs,
    loc_key: source.loc_key || 'MESSAGE_TEXT',
    mute: source.mute ?? Boolean.False,
    badge: source.badge ?? Boolean.True,
    random_id: Number(source.random_id) || Date.now(),
    date: source.date ? Number(source.date) : undefined,
    title: title || JUST_CHAT_TITLE,
    description: description || GENERIC_PUSH_DESCRIPTION,
  };
}

function isFcmEnvelope(payload: any) {
  return payload.data instanceof Object
    && !payload.custom
    && !payload.loc_key;
}

function isBadgeOnlyPush(payload: unknown) {
  if (!payload || typeof payload !== 'object') return false;
  const fields = isFcmEnvelope(payload) ? (payload as { data: object }).data : payload;
  return Object.keys(fields).every((key) => key === 'badge');
}

function unwrapFcmData(data: Record<string, unknown>) {
  const fields: Record<string, any> = {};
  Object.entries(data).forEach(([key, value]) => {
    fields[key] = typeof value === 'string' ? parseFcmField(value) : value;
  });
  return fields;
}

function parseCustom(value: unknown) {
  const parsed = typeof value === 'string' ? parseFcmField(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  return parsed as PushData['custom'];
}

function parseLocArgs(value: unknown) {
  const parsed = typeof value === 'string' ? parseFcmField(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => String(item));
}

function parseFcmField(value: string) {
  if (!FCM_JSON_FIELD_RE.test(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function buildGenericPushData(): PushData {
  return {
    custom: {},
    mute: Boolean.False,
    badge: Boolean.True,
    loc_key: 'MESSAGE_TEXT',
    loc_args: [],
    random_id: Date.now(),
    title: JUST_CHAT_TITLE,
    description: GENERIC_PUSH_DESCRIPTION,
  };
}

function getChatId(data: PushData) {
  if (data.custom.from_id) {
    return data.custom.from_id;
  }

  // Chats and channels have “negative” IDs
  if (data.custom.chat_id || data.custom.channel_id) {
    return `-${data.custom.chat_id || data.custom.channel_id}`;
  }

  return undefined;
}

function getMessageId(data: PushData) {
  if (!data.custom.msg_id) return undefined;
  return parseInt(data.custom.msg_id, 10);
}

function toNotificationTimestamp(date?: number) {
  if (!date) return undefined;
  return date < UNIX_MS_THRESHOLD ? date * SECONDS_TO_MS : date;
}

function latestSentAt(current?: number, next?: number) {
  if (current === undefined) return next;
  if (next === undefined) return current;
  return Math.max(current, next);
}

// A timestamp ahead of the device clock is rejected by `showNotification`, so the alert never appears.
function clampNotificationTimestamp(sentAt?: number) {
  if (!sentAt) return undefined;
  return Math.min(sentAt, Date.now());
}

function getNotificationData(data: PushData): NotificationData {
  const chatId = getChatId(data);
  let title = (isOfficialTelegramServiceChat(chatId) ? JUST_CHAT_TITLE : data.title) || APP_NAME;
  const isSilent = data.custom?.silent === Boolean.True;
  if (isSilent) {
    title += ' 🔕';
  }
  return {
    chatId,
    messageId: getMessageId(data),
    body: data.description,
    isSilent,
    title,
    icon: isOfficialTelegramServiceChat(chatId) ? 'icon-192x192.png' : undefined,
    sentAt: toNotificationTimestamp(data.date),
  };
}

async function getClients() {
  const appUrl = new URL(self.registration.scope).origin;
  const clients = await self.clients.matchAll({ type: 'window' }) as WindowClient[];
  return clients.filter((client) => {
    return new URL(client.url).origin === appUrl;
  });
}

async function playNotificationSound(id: string) {
  const clients = await getClients();
  const client = clients[0];
  if (!client) return;
  client.postMessage({
    type: 'playNotificationSound',
    payload: { id },
  });
}

function getInboxKey(chatId?: string) {
  return chatId || '0';
}

function formatRow(text?: string) {
  const flattened = (text || '').replace(ROW_WHITESPACE_RE, ' ').trim();
  return trimText(flattened, MAX_ROW_LENGTH) || '';
}

function isInboxEntry(value: unknown): value is InboxEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as InboxEntry;
  return typeof entry.title === 'string'
    && Array.isArray(entry.bodies)
    && entry.bodies.every((body) => typeof body === 'string');
}

function restoreInbox() {
  if (inboxByChatKey.size) return Promise.resolve();
  if (restorePromise) return restorePromise;

  restorePromise = (async () => {
    const notifications = await self.registration.getNotifications({ tag: APP_NOTIFICATION_TAG });
    const stored = notifications[0]?.data?.entries;
    if (!Array.isArray(stored)) return;

    stored.forEach((entry) => {
      if (!isInboxEntry(entry)) return;
      inboxByChatKey.set(getInboxKey(entry.chatId), entry);
    });
  })().finally(() => {
    restorePromise = undefined;
  });

  return restorePromise;
}

function rememberInboxEntry(notification: NotificationData) {
  const key = getInboxKey(notification.chatId);
  // A real sender replaces the closed-app "New message" row
  if (notification.chatId) {
    inboxByChatKey.delete(getInboxKey(undefined));
  }
  const previous = inboxByChatKey.get(key);
  if (previous && notification.messageId && previous.messageId === notification.messageId) {
    return false;
  }

  const bodies = [...(previous?.bodies || []), notification.body].slice(-MAX_LINES_PER_CHAT);
  inboxByChatKey.delete(key);
  inboxByChatKey.set(key, {
    chatId: notification.chatId,
    title: notification.title,
    bodies,
    messageId: notification.messageId,
    icon: notification.icon || previous?.icon,
    reaction: notification.reaction,
    isSilent: notification.isSilent,
    shouldReplaceHistory: notification.shouldReplaceHistory,
    sentAt: latestSentAt(previous?.sentAt, notification.sentAt),
  });

  while (inboxByChatKey.size > MAX_INBOX_CHATS) {
    const oldestKey = inboxByChatKey.keys().next().value;
    if (!oldestKey) break;
    inboxByChatKey.delete(oldestKey);
  }

  return true;
}

function buildGroupedNotification(shouldAlert: boolean, incomingSentAt?: number) {
  const entries = Array.from(inboxByChatKey.values()).reverse();
  const onlyEntry = entries.length === 1 ? entries[0] : undefined;
  const title = onlyEntry ? onlyEntry.title : APP_NAME;
  // One short row per sender, newest chat first. The saved entries keep the full text.
  const body = onlyEntry
    ? onlyEntry.bodies.map((line) => formatRow(line)).join('\n')
    : entries.map((entry) => formatRow(`${entry.title}: ${entry.bodies[entry.bodies.length - 1]}`)).join('\n');
  const messageCount = entries.reduce((sum, entry) => sum + entry.bodies.length, 0);
  const newestSentAt = entries.reduce<number | undefined>(
    (latest, entry) => latestSentAt(latest, entry.sentAt),
    undefined,
  );
  // A dateless message just arrived, so the card clock is the current time
  const sentAt = shouldAlert && !incomingSentAt
    ? Date.now()
    : clampNotificationTimestamp(latestSentAt(newestSentAt, incomingSentAt));

  const options: AppNotificationOptions = {
    body,
    data: {
      chatId: onlyEntry?.chatId,
      messageId: onlyEntry?.messageId,
      reaction: onlyEntry?.reaction,
      count: messageCount,
      shouldReplaceHistory: onlyEntry?.shouldReplaceHistory,
      entries: Array.from(inboxByChatKey.values()),
    },
    icon: onlyEntry?.icon || 'icon-192x192.png',
    badge: 'icon-192x192.png',
    tag: APP_NOTIFICATION_TAG,
    silent: !shouldAlert,
  };

  if (sentAt) {
    options.timestamp = sentAt;
  }

  if (shouldAlert) {
    // @ts-ignore
    options.vibrate = [200, 100, 200];
    // Replacing the card must still alert when another message arrives
    // @ts-ignore
    options.renotify = true;
  }

  return { title, options };
}

async function publishInbox(shouldAlert: boolean, incomingSentAt?: number, trace?: NotificationTrace) {
  const grouped = inboxByChatKey.size
    ? buildGroupedNotification(shouldAlert, incomingSentAt)
    : undefined;
  logNotificationTrace(trace, 'readingNotifications');
  const notifications = await self.registration.getNotifications();
  // The previous card is closed first so this alert gets a new clock
  notifications.forEach((notification) => notification.close());

  if (!grouped) {
    logNotificationTrace(trace, 'skipEmptyInbox');
    return;
  }

  const { title, options } = grouped;
  return publishNotification(title, options, trace);
}

async function publishNotification(title: string, options: NotificationOptions, trace?: NotificationTrace) {
  logNotificationTrace(trace, 'showNotificationAttempt');
  try {
    await self.registration.showNotification(title, options);
    logNotificationTrace(trace, 'showNotificationResolved');
    return;
  } catch (err) {
    logNotificationTrace(trace, 'showNotificationRejected', err);
  }

  // A rejected timestamp or `renotify` must not swallow the alert
  const fallbackOptions: NotificationOptions = { ...options };
  Reflect.deleteProperty(fallbackOptions, 'timestamp');
  Reflect.deleteProperty(fallbackOptions, 'renotify');
  logNotificationTrace(trace, 'showNotificationRetryAttempt');
  try {
    await self.registration.showNotification(title, fallbackOptions);
    logNotificationTrace(trace, 'showNotificationRetryResolved');
  } catch (err) {
    logNotificationTrace(trace, 'showNotificationRetryRejected', err);
    throw err;
  }
}

async function showNotification(notification: NotificationData, trace?: NotificationTrace) {
  logNotificationTrace(trace, 'restoringInbox');
  await restoreInbox();
  const hadWakeRow = inboxByChatKey.has(getInboxKey(undefined));
  if (!rememberInboxEntry(notification)) {
    // A duplicate preview still replaces the closed-app "New message" row
    if (hadWakeRow && notification.chatId) {
      await publishInbox(false, undefined, trace);
    } else if (IS_SAFARI && trace?.source === 'push') {
      return showDuplicatePushNotification(notification, trace);
    } else {
      logNotificationTrace(trace, 'skipDuplicateInboxEntry');
    }
    return undefined;
  }

  const shouldAlert = !notification.reaction && !notification.isSilent;
  // TODO Update condition when reaction badges are implemented
  const soundTask = shouldAlert
    ? playNotificationSound(String(notification.messageId) || notification.chatId || '')
    : undefined;
  const notificationTask = publishInbox(shouldAlert, notification.sentAt, trace);
  if (trace) trace.notificationTask = notificationTask;

  return Promise.all([soundTask, notificationTask]);
}

function showDuplicatePushNotification(notification: NotificationData, trace: NotificationTrace) {
  logNotificationTrace(trace, 'duplicatePushNotificationRequested');
  if (notification.chatId) inboxByChatKey.delete(getInboxKey(undefined));
  const inboxEntry = inboxByChatKey.get(getInboxKey(notification.chatId));
  const previewEntry = notification.messageId !== undefined && inboxEntry?.messageId === notification.messageId
    ? inboxEntry : undefined;
  // Only a matching stored preview supplies visible message content
  const options: NotificationOptions = {
    body: previewEntry?.bodies[previewEntry.bodies.length - 1],
    data: {
      chatId: notification.chatId,
      messageId: notification.messageId,
      reaction: notification.reaction,
      shouldReplaceHistory: notification.shouldReplaceHistory,
      count: 1,
      entries: Array.from(inboxByChatKey.values()),
    },
    icon: previewEntry?.icon || 'icon-192x192.png',
    badge: 'icon-192x192.png',
    tag: APP_NOTIFICATION_TAG,
    silent: true,
  };
  const notificationTask = publishNotification(previewEntry?.title || APP_NAME, options, trace);
  trace.notificationTask = notificationTask;
  return notificationTask;
}

async function closeNotifications({
  chatId,
  lastReadInboxMessageId,
}: CloseNotificationData, trace?: NotificationTrace) {
  // Only an inbox read cursor dismisses the alert
  if (!lastReadInboxMessageId) return;

  await restoreInbox();
  const key = getInboxKey(chatId);
  const entry = inboxByChatKey.get(key);
  if (!entry || (entry.messageId !== undefined && entry.messageId > lastReadInboxMessageId)) return;

  inboxByChatKey.delete(key);
  await publishInbox(false, undefined, trace);
}

async function checkIfAppIsVisible(trace?: NotificationTrace) {
  const clients = await getClients();
  const isAppVisible = clients.some((client) => client.visibilityState === 'visible');
  if (trace) {
    recordPushDiagnosticStep(trace.diagnostic, 'clientVisibility', { isAppVisible });
  }
  return isAppVisible;
}

async function showPreviewWhenAppIsHidden(notification: NotificationData, trace?: NotificationTrace) {
  // A visible window decides on its own whether the message needs an alert
  if (await checkIfAppIsVisible(trace)) {
    logNotificationTrace(trace, 'skipAppVisible');
    return;
  }
  await showNotification(notification, trace);
}

async function showWakeWhenAppIsClosed(notification: NotificationData, trace?: NotificationTrace) {
  if (await checkIfAppIsVisible(trace)) {
    logNotificationTrace(trace, 'skipAppVisible');
    return;
  }

  // Telegram sends one message as both an empty wake and a preview push, in either order
  const receivedAt = Date.now();
  await waitFor(EMPTY_WAKE_WAIT_MS);
  if (lastPreviewPushAt >= receivedAt - EMPTY_WAKE_WAIT_MS) {
    logNotificationTrace(trace, 'skipWakeNearPreview');
    return;
  }
  if (Date.now() - lastEmptyWakeShownAt < EMPTY_WAKE_WAIT_MS) {
    logNotificationTrace(trace, 'skipRecentWake');
    return;
  }

  lastEmptyWakeShownAt = Date.now();
  await showNotification(notification, trace);
}

function waitFor(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function dismissChatlessNotification(trace?: NotificationTrace) {
  await restoreInbox();
  const key = getInboxKey(undefined);
  if (!inboxByChatKey.has(key)) return;
  inboxByChatKey.delete(key);
  await publishInbox(false, undefined, trace);
}

export function handlePush(e: PushEvent) {
  const trace = createNotificationTrace('push');
  logNotificationTrace(trace, 'pushReceived');
  const raw = readPushRaw(e, trace);

  e.waitUntil(trackNotificationTask(processPush(raw, trace), trace));
}

async function processPush(raw: unknown, trace?: NotificationTrace) {
  logNotificationTrace(trace, 'readingPayload');
  const payload = await decryptFcmPush(raw, trace);
  logNotificationTrace(trace, 'payloadReady');
  // A badge-only push carries no message; the open app or a preview push shows that message
  if (isBadgeOnlyPush(payload)) {
    logNotificationTrace(trace, 'skipBadgeOnly');
    return undefined;
  }

  const data = rawToPushData(payload);
  if (trace) {
    const notificationType = data.loc_key;
    trace.notificationType = typeof notificationType === 'string' && PUSH_NOTIFICATION_TYPE_RE.test(notificationType)
      ? notificationType : undefined;
    logNotificationTrace(trace, 'payloadClassified');
  }

  // Do not show muted notifications
  if (!data || data.mute === Boolean.True) {
    logNotificationTrace(trace, data ? 'skipMuted' : 'skipMissingData');
    return undefined;
  }

  const notification = getNotificationData(data);

  // Login and data-center pushes come from the hidden service account
  if (HIDDEN_SERVICE_LOC_KEYS.has(data.loc_key)) {
    lastPreviewPushAt = Date.now();
    logNotificationTrace(trace, 'skipServiceMessage');
    return undefined;
  }

  // A push without a sender carries no message preview. FCM can still include the text in `loc_args`.
  if (!notification.chatId) {
    if (notification.body && notification.body !== GENERIC_PUSH_DESCRIPTION) {
      lastPreviewPushAt = Date.now();
      return showPreviewWhenAppIsHidden(notification, trace);
    }
    return showWakeWhenAppIsClosed(notification, trace);
  }

  lastPreviewPushAt = Date.now();

  if (
    (isChatHidden(notification.chatId) || isInternalChat(notification.chatId))
    && !isAdsPlatformLoginText(notification.body)
  ) {
    logNotificationTrace(trace, 'skipHiddenChat');
    return undefined;
  }

  // The page can request a message notification before its push arrives
  if (shownNotifications.has(notification.messageId)) {
    shownNotifications.delete(notification.messageId);
    if (IS_SAFARI && trace?.source === 'push') {
      return showDuplicatePushNotification(notification, trace);
    }
    logNotificationTrace(trace, 'skipAlreadyShown');
    return dismissChatlessNotification(trace);
  }

  return showPreviewWhenAppIsHidden(notification, trace);
}

// FCM pushes registered with a `secret` carry the Telegram payload encrypted in `data.p`
async function decryptFcmPush(raw: unknown, trace?: NotificationTrace) {
  if (!raw || typeof raw !== 'object' || !isFcmEnvelope(raw)) return raw;
  const encoded = (raw as { data: { p?: unknown } }).data.p;
  if (typeof encoded !== 'string') return raw;

  try {
    const secret = await loadPushSecret();
    const payload = secret ? await decryptTelegramPush(encoded, secret) : undefined;
    logNotificationTrace(trace, payload ? 'payloadDecrypted' : 'payloadDecryptionUnavailable');
    return payload ?? raw;
  } catch (err) {
    logNotificationTrace(trace, 'payloadDecryptionFailed', err);
    return raw;
  }
}

async function focusChatMessage(client: WindowClient, data: FocusMessageData) {
  if (data.chatId) {
    client.postMessage({
      type: 'focusMessage',
      payload: data,
    });
  }
  if (!client.focused) {
    // Catch "focus not allowed" DOM Exceptions
    try {
      await client.focus();
    } catch (error) {
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.warn('[SW] ', error);
      }
    }
  }
}

export function handleNotificationClick(e: NotificationEvent) {
  const appUrl = self.registration.scope;
  e.notification.close(); // Android needs explicit close.
  const { data } = e.notification;
  const notifyClients = async () => {
    const clients = await getClients();
    await Promise.all(clients.map((client) => {
      clickBuffer[client.id] = data;
      return focusChatMessage(client, data);
    }));
    if (!self.clients.openWindow || clients.length > 0) return undefined;
    // Store notification data for default client (fix for android)
    clickBuffer[0] = data;
    // If there is no opened client we need to open one and wait until it is fully loaded
    try {
      const newClient = await self.clients.openWindow(appUrl);
      if (newClient) {
        // Store notification data until client is fully loaded
        clickBuffer[newClient.id] = data;
      }
    } catch (error) {
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.warn('[SW] ', error);
      }
    }
    return undefined;
  };
  e.waitUntil(notifyClients());
}

export function handleClientMessage(e: ExtendableMessageEvent) {
  if (DEBUG_MORE) {
    // eslint-disable-next-line no-console
    console.log('[SW] New message from client', e);
  }
  if (!e.data) return;
  const source = e.source as WindowClient;
  if (e.data.type === 'clientReady') {
    // focus on chat message when client is fully ready
    const data = clickBuffer[source.id] || clickBuffer[0];
    if (data) {
      delete clickBuffer[source.id];
      delete clickBuffer[0];
      e.waitUntil(focusChatMessage(source, data));
    }
  }
  if (e.data.type === 'showMessageNotification') {
    const trace = createNotificationTrace('showMessageNotification');
    logNotificationTrace(trace, 'clientMessageReceived');
    // store messageId for already shown notification
    const notification: NotificationData = e.data.payload;
    e.waitUntil(trackNotificationTask((async () => {
      await showNotification(notification, trace);
      // Mark only after a successful show, so a failed attempt can still arrive via push.
      shownNotifications.add(notification.messageId);
    })(), trace));
  }

  if (e.data.type === 'closeMessageNotifications') {
    const trace = createNotificationTrace('closeMessageNotifications');
    logNotificationTrace(trace, 'clientMessageReceived');
    e.waitUntil(trackNotificationTask(closeNotifications(e.data.payload, trace), trace));
  }

  if (e.data.type === 'dismissChatlessNotification') {
    const trace = createNotificationTrace('dismissChatlessNotification');
    logNotificationTrace(trace, 'clientMessageReceived');
    e.waitUntil(trackNotificationTask(dismissChatlessNotification(trace), trace));
  }
}

function createNotificationTrace(source: NotificationTrace['source']): NotificationTrace {
  lastNotificationTraceId += 1;
  return { id: lastNotificationTraceId, source, diagnostic: createPushDiagnosticTrace(source) };
}

function trackNotificationTask(task: Promise<unknown>, trace?: NotificationTrace) {
  if (!trace) return task;
  return task.then((result) => {
    logNotificationTrace(trace, 'processingCompleted');
    return result;
  }, (err: unknown) => {
    logNotificationTrace(trace, 'processingFailed', err);
    throw err;
  }).finally(async () => {
    // A sound failure can settle processing before the notification request finishes
    await trace.notificationTask?.catch(() => undefined);
    if (trace.source === 'push') {
      trace.hasNotificationRequestResolved ??= false;
      logNotificationTrace(trace, trace.hasNotificationRequestResolved
        ? 'pushNotificationRequestResolved' : 'pushCompletedWithoutNotification');
    }
    await flushPushDiagnosticTrace(trace.diagnostic);
  });
}

function logNotificationTrace(trace: NotificationTrace | undefined, status: string, err?: unknown) {
  if (!trace) return;
  if (status === 'showNotificationResolved' || status === 'showNotificationRetryResolved') {
    trace.hasNotificationRequestResolved = true;
  }
  if (status.startsWith('skip')) {
    trace.skipReason = status;
  }
  const shouldLogErrorMessage = status === 'showNotificationRejected' || status === 'showNotificationRetryRejected';
  const details = {
    permission: typeof Notification !== 'undefined' ? Notification.permission : undefined,
    scope: self.registration.scope,
    workerUrl: self.location.href,
    activeWorkerUrl: self.registration.active?.scriptURL,
    workerState: self.registration.active?.state,
    errorName: err instanceof Error ? err.name : undefined,
    errorMessage: shouldLogErrorMessage && err instanceof Error ? err.message : undefined,
    hasNotificationRequestResolved: trace.hasNotificationRequestResolved,
    skipReason: trace.skipReason,
    notificationType: trace.notificationType,
  };
  recordPushDiagnosticStep(trace.diagnostic, status, details);
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('[SW] Notification trace', { id: trace.id, source: trace.source, status, ...details });
  }
}
