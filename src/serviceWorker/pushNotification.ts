import { APP_NAME, DEBUG, DEBUG_MORE } from '../config';
import { isChatHidden } from '../util/hiddenChats';
import { isInternalChat } from '../util/internalChats';
import {
  isAdsPlatformLoginText, isOfficialTelegramServiceChat, JUST_CHAT_TITLE,
} from '../util/officialTelegramAds';
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

const inboxByChatKey = new Map<string, InboxEntry>();
const shownNotifications = new Set();
const clickBuffer: Record<string, NotificationData> = {};
let restorePromise: Promise<void> | undefined;
let lastPreviewPushAt = 0;
let lastEmptyWakeShownAt = 0;

function getPushData(e: PushEvent | Notification): PushData | undefined {
  if (!('data' in e) || !e.data) {
    return buildGenericPushData();
  }

  if (typeof (e.data as PushEvent['data'])?.json !== 'function') {
    return e.data as PushData;
  }

  try {
    return e.data.json();
  } catch (error) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log('[SW] Unable to parse push notification data', e.data);
    }
    return undefined;
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
    description: 'New message',
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

async function publishInbox(shouldAlert: boolean, incomingSentAt?: number) {
  const grouped = inboxByChatKey.size
    ? buildGroupedNotification(shouldAlert, incomingSentAt)
    : undefined;
  const notifications = await self.registration.getNotifications();
  // The previous card is closed first so this alert gets a new clock
  notifications.forEach((notification) => notification.close());

  if (!grouped) return;

  const { title, options } = grouped;
  try {
    await self.registration.showNotification(title, options);
  } catch (err) {
    // A rejected timestamp or `renotify` must not swallow the alert
    const fallbackOptions: NotificationOptions = { ...options };
    Reflect.deleteProperty(fallbackOptions, 'timestamp');
    Reflect.deleteProperty(fallbackOptions, 'renotify');
    await self.registration.showNotification(title, fallbackOptions);
  }
}

async function showNotification(notification: NotificationData) {
  await restoreInbox();
  if (!rememberInboxEntry(notification)) return undefined;

  const shouldAlert = !notification.reaction && !notification.isSilent;

  return Promise.all([
    // TODO Update condition when reaction badges are implemented
    shouldAlert
      ? playNotificationSound(String(notification.messageId) || notification.chatId || '')
      : undefined,
    publishInbox(shouldAlert, notification.sentAt),
  ]);
}

async function closeNotifications({
  chatId,
  lastReadInboxMessageId,
}: CloseNotificationData) {
  // Only an inbox read cursor dismisses the alert
  if (!lastReadInboxMessageId) return;

  await restoreInbox();
  const key = getInboxKey(chatId);
  const entry = inboxByChatKey.get(key);
  if (!entry || (entry.messageId !== undefined && entry.messageId > lastReadInboxMessageId)) return;

  inboxByChatKey.delete(key);
  await publishInbox(false);
}

async function checkIfAppIsVisible() {
  const clients = await getClients();
  return clients.some((client) => client.visibilityState === 'visible');
}

async function showPreviewWhenAppIsHidden(notification: NotificationData) {
  // A visible window decides on its own whether the message needs an alert
  if (await checkIfAppIsVisible()) return;
  await showNotification(notification);
}

async function showWakeWhenAppIsClosed(notification: NotificationData) {
  if (await checkIfAppIsVisible()) return;

  // Telegram sends one message as both an empty wake and a preview push, in either order
  const receivedAt = Date.now();
  await waitFor(EMPTY_WAKE_WAIT_MS);
  if (lastPreviewPushAt >= receivedAt - EMPTY_WAKE_WAIT_MS) return;
  if (Date.now() - lastEmptyWakeShownAt < EMPTY_WAKE_WAIT_MS) return;

  lastEmptyWakeShownAt = Date.now();
  await showNotification(notification);
}

function waitFor(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function dismissChatlessNotification() {
  await restoreInbox();
  const key = getInboxKey(undefined);
  if (!inboxByChatKey.has(key)) return;
  inboxByChatKey.delete(key);
  await publishInbox(false);
}

export function handlePush(e: PushEvent) {
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('[SW] Push received event', e);
    if (e.data) {
      // eslint-disable-next-line no-console
      console.log('[SW] Push received with data', e.data.json());
    }
  }

  const data = getPushData(e);

  // Do not show muted notifications
  if (!data || data.mute === Boolean.True) return;

  const notification = getNotificationData(data);

  // Login and data-center pushes come from the hidden service account
  if (HIDDEN_SERVICE_LOC_KEYS.has(data.loc_key)) {
    lastPreviewPushAt = Date.now();
    return;
  }

  // A push without a sender carries no message preview
  if (!notification.chatId) {
    e.waitUntil(showWakeWhenAppIsClosed(notification));
    return;
  }

  lastPreviewPushAt = Date.now();

  if (
    (isChatHidden(notification.chatId) || isInternalChat(notification.chatId))
    && !isAdsPlatformLoginText(notification.body)
  ) return;

  // Don't show already triggered notification
  if (shownNotifications.has(notification.messageId)) {
    shownNotifications.delete(notification.messageId);
    return;
  }

  e.waitUntil(showPreviewWhenAppIsHidden(notification));
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
    // store messageId for already shown notification
    const notification: NotificationData = e.data.payload;
    e.waitUntil((async () => {
      await showNotification(notification);
      // Mark only after a successful show, so a failed attempt can still arrive via push.
      shownNotifications.add(notification.messageId);
    })());
  }

  if (e.data.type === 'closeMessageNotifications') {
    e.waitUntil(closeNotifications(e.data.payload));
  }

  if (e.data.type === 'dismissChatlessNotification') {
    e.waitUntil(dismissChatlessNotification());
  }
}
