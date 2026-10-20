import type { ApiReaction } from '../api/types';
import type { PushDiagnosticTrace, PushPreviewHiddenReason } from '../util/pushDiagnostics';
import type { PushNotificationContext } from '../util/pushNotificationContext';

import { APP_NAME, CHANNEL_ID_BASE, DEBUG, DEBUG_MORE } from '../config';
import { IdbStore } from '../util/browser/idb';
import { isChannelId, toChannelId } from '../util/entities/ids';
import { isChatHidden } from '../util/hiddenChats';
import { isInternalChat } from '../util/internalChats';
import {
  isAdsPlatformLoginText, isOfficialTelegramServiceChat, JUST_CHAT_TITLE,
} from '../util/officialTelegramAds';
import {
  createPushDiagnosticTrace, flushPushDiagnosticTrace, recordPushDiagnosticStep,
} from '../util/pushDiagnostics';
import {
  checkIfControlPush, checkIfMessagePushType, getPushNotificationContext,
} from '../util/pushNotificationContext';
import { decryptTelegramPush, loadPushSecret, loadRegisteredPushSecret } from '../util/telegramPushSecret';
import trimText from '../util/trimText';

declare const self: ServiceWorkerGlobalScope;

type PushFlag = '0' | '1';

type PushData = {
  date?: number;
  custom: {
    msg_id?: string;
    silent?: string;
    channel_id?: string;
    chat_id?: string;
    from_id?: string;
    max_id?: string;
    messages?: string;
    story_id?: string;
    top_msg_id?: string;
    topic_id?: string;
    edit_date?: string;
    call_id?: string;
  };
  user_id?: string;
  mute: PushFlag;
  badge?: number | string;
  loc_key: string;
  loc_args: string[];
  random_id: number;
  title: string;
  description: string;
  hasPreviewText?: boolean;
};

type NotificationData = {
  userId?: string;
  shouldHidePreview?: boolean;
  messageId?: number;
  chatId?: string;
  title: string;
  body: string;
  isSilent?: boolean;
  icon?: string;
  reaction?: ApiReaction;
  isReaction?: boolean;
  storyId?: number;
  threadId?: number;
  editDate?: number;
  eventKind?: NotificationEventKind;
  shouldReplaceHistory?: boolean;
  sentAt?: number;
};

type FocusMessageData = {
  userId?: string;
  chatId?: string;
  messageId?: number;
  reaction?: ApiReaction;
  storyId?: number;
  threadId?: number;
  shouldReplaceHistory?: boolean;
};

type CloseNotificationData = {
  userId?: string;
  threadId?: number;
  lastReadInboxMessageId?: number;
  chatId: string;
};

const APP_NOTIFICATION_TAG = 'justchat';
const UNSCOPED_NOTIFICATION_TAG = 'justchat-unscoped';
const PUSH_FLAG_TRUE = '1';
const PUSH_FLAG_FALSE = '0';
const MAX_INBOX_CHATS = 8;
const MAX_LINES_PER_CHAT = 5;
const MAX_ROW_LENGTH = 60;
const MAX_DELETED_MESSAGES = 1000;
const MAX_PENDING_NOTIFICATION_CLOSES = 256;
const SECONDS_TO_MS = 1000;
const UNIX_MS_THRESHOLD = 1e12;
const ROW_WHITESPACE_RE = /\s+/g;
const HIDDEN_SERVICE_LOC_KEYS = new Set(['AUTH_UNKNOWN', 'AUTH_REGION', 'DC_UPDATE']);
const PRIVATE_PUSH_TYPES = new Set([
  'LOCKED_MESSAGE', 'STORY_HIDDEN_AUTHOR', 'REACT_HIDDEN', 'REACT_STORY_HIDDEN',
  'ENCRYPTION_REQUEST', 'ENCRYPTION_ACCEPT', 'ENCRYPTED_MESSAGE',
]);
const EMPTY_WAKE_WAIT_MS = 3000;
const PAGE_PUSH_WAIT_MS = 2000;
const GENERIC_PUSH_DESCRIPTION = 'New message';
const FCM_JSON_FIELD_RE = /^[[{]/;
const MESSAGE_PUSH_TYPE_RE = /^(?:CHAT_|CHANNEL_)?(?:MESSAGE_([A-Z_]+)|(MESSAGES))$/;
const PUSH_NOTIFICATION_TYPE_RE = /^[A-Z_0-9]{1,64}$/;
const IS_SAFARI = /applewebkit/i.test(self.navigator.userAgent)
  && !/Chrom(e|ium)\//.test(self.navigator.userAgent);
const PUSH_INBOX_STORE = new IdbStore('tt-push-inbox');
const PUSH_INBOX_KEY = 'inbox';
const PENDING_NOTIFICATION_CLOSES_KEY = 'pendingCloses';
const DEFAULT_NOTIFICATION_ICON = 'icon-192x192.png';
const SAFARI_NOTIFICATION_LIFETIME_MS = 31 * 1000;
const SAFARI_PUSH_FALLBACK_DELAY_MS = 8000;
const PUSH_STORAGE_TIMEOUT_MS = 2000;

type NotificationEventKind = 'message' | 'reaction' | 'story' | 'storyReaction';
type InboxMessage = Pick<NotificationData,
  'body' | 'messageId' | 'storyId' | 'threadId' | 'editDate' | 'sentAt' | 'reaction' | 'eventKind'>;

type InboxEntry = {
  chatId?: string;
  title: string;
  bodies: string[];
  messageId?: number;
  icon?: string;
  reaction?: ApiReaction;
  messages?: InboxMessage[];
  storyId?: number;
  threadId?: number;
  eventKind?: NotificationEventKind;
  isSilent?: boolean;
  shouldReplaceHistory?: boolean;
  sentAt?: number;
};

type AppNotificationOptions = NotificationOptions & {
  timestamp?: number;
};

type PendingNotificationClose = {
  userId: string;
  instanceId?: string;
  notificationKey: string;
  shownAt: number;
  closeAt: number;
};

type NotificationTrace = {
  id: number;
  source: 'push' | 'showMessageNotification' | 'closeMessageNotifications' | 'dismissChatlessNotification'
    | 'deleteMessageNotifications' | 'updateMessageNotification' | 'cleanupMessageNotifications';
  diagnostic: PushDiagnosticTrace;
  hasNotificationRequestResolved?: boolean;
  hasEmergencyNotificationRequestResolved?: boolean;
  resolveNotificationRequest?: NoneToVoidFunction;
  skipReason?: string;
  notificationType?: string;
  previewHiddenReason?: PushPreviewHiddenReason;
  hasPayloadPreviewText?: boolean;
  notificationTask?: Promise<void>;
  isPayloadAuthenticated?: boolean;
  authenticatedUserId?: string;
  hasPayloadUserId?: boolean;
  hasAccountContext?: boolean;
  recipientUserId?: string;
};

const inboxByChatKey = new Map<string, InboxEntry>();
const shownNotifications = new Set<string>();
const deletedMessageKeys = new Set<string>();
const pendingPageNotifications = new Set<NotificationData>();
const clickBuffer: Record<string, NotificationData> = {};
let restorePromise: Promise<void> | undefined;
let hasRestoredInbox = false;
let inboxUserId: string | undefined;
let notificationContext: PushNotificationContext | undefined;
let notificationQueue = Promise.resolve();
let lastPreviewPushAt = 0;
let lastEmptyWakeShownAt = 0;
let lastNotificationTraceId = 0;
let notificationCleanupTimer: ReturnType<typeof setTimeout> | undefined;

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
  if (custom.messages === undefined && source.messages !== undefined) {
    custom.messages = Array.isArray(source.messages) ? source.messages.join(',') : String(source.messages);
  }

  const locArgs = parseLocArgs(source.loc_args);
  const notification = payload.notification;
  const title = source.title
    || notification?.title
    || (source.loc_key?.startsWith('CHAT_') ? locArgs[1] : locArgs[0]);
  const description = source.description
    || notification?.body
    || source.message
    || (source.loc_key?.endsWith('_TEXT') ? locArgs[locArgs.length - 1] : undefined);
  if (!source.custom && !source.loc_key && !description && source.badge === undefined) return undefined;

  return {
    ...source,
    custom,
    loc_args: locArgs,
    loc_key: source.loc_key || 'MESSAGE_TEXT',
    mute: String(source.mute ?? PUSH_FLAG_FALSE) === PUSH_FLAG_TRUE ? PUSH_FLAG_TRUE : PUSH_FLAG_FALSE,
    badge: source.badge,
    user_id: source.user_id === undefined ? undefined : String(source.user_id),
    random_id: Number(source.random_id) || Date.now(),
    date: source.date ? Number(source.date) : undefined,
    title: title || JUST_CHAT_TITLE,
    description: description || GENERIC_PUSH_DESCRIPTION,
    hasPreviewText: Boolean(description) || undefined,
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
    mute: PUSH_FLAG_FALSE,
    loc_key: 'MESSAGE_TEXT',
    loc_args: [],
    random_id: Date.now(),
    title: JUST_CHAT_TITLE,
    description: GENERIC_PUSH_DESCRIPTION,
  };
}

function getChatId(data: PushData) {
  if (data.custom.channel_id) {
    return normalizeChannelPushId(String(data.custom.channel_id));
  }

  if (data.custom.chat_id) {
    return normalizeBasicChatPushId(String(data.custom.chat_id));
  }

  if (data.custom.from_id) {
    return String(data.custom.from_id);
  }

  return undefined;
}

function getMessageId(data: PushData) {
  if (!data.custom.msg_id) return undefined;
  return parsePushId(data.custom.msg_id);
}

function parsePushId(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePushIds(value: unknown) {
  if (Array.isArray(value)) {
    return value.map(parsePushId).filter((id): id is number => id !== undefined);
  }
  if (typeof value !== 'string' && typeof value !== 'number') return [];
  return String(value).split(',').map(parsePushId).filter((id): id is number => id !== undefined);
}

function normalizeChannelPushId(id: string) {
  const peerId = BigInt(id);
  if (peerId < -CHANNEL_ID_BASE) return String(peerId);
  return toChannelId(String(peerId < 0n ? -peerId : peerId));
}

function normalizeBasicChatPushId(id: string) {
  if (id.startsWith('-')) return id;
  return `-${id}`;
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

function getNotificationData(
  data: PushData, context?: PushNotificationContext, trace?: NotificationTrace,
): NotificationData {
  const chatId = getChatId(data);
  const isReaction = data.loc_key.startsWith('REACT_') || data.loc_key.startsWith('CHAT_REACT_');
  const isStory = data.loc_key.startsWith('STORY_');
  const storyId = parsePushId(data.custom.story_id);
  const eventKind = isReaction ? (storyId ? 'storyReaction' : 'reaction') : (isStory ? 'story' : 'message');
  const shouldHidePreview = PRIVATE_PUSH_TYPES.has(data.loc_key) || undefined;
  const previewHiddenReason = getPreviewHiddenReason({ chatId, shouldHidePreview }, context);
  if (trace && previewHiddenReason) {
    trace.previewHiddenReason = previewHiddenReason;
    logNotificationTrace(trace, 'pushPreviewHidden');
  }
  const canShowPreview = data.user_id && data.user_id === context?.userId && !previewHiddenReason;
  let title = (isOfficialTelegramServiceChat(chatId) ? JUST_CHAT_TITLE : data.title) || APP_NAME;
  const isSilent = String(data.custom.silent) === PUSH_FLAG_TRUE || isReaction;
  if (isSilent) {
    title += ' 🔕';
  }
  return {
    chatId,
    userId: data.user_id,
    shouldHidePreview,
    messageId: getMessageId(data),
    body: canShowPreview ? getPushMessageBody(data, context) : context?.messageText || '',
    isSilent,
    title: canShowPreview ? title : APP_NAME,
    isReaction: isReaction || undefined,
    storyId,
    threadId: parsePushId(data.custom.top_msg_id || data.custom.topic_id),
    editDate: parsePushId(data.custom.edit_date),
    eventKind,
    icon: isOfficialTelegramServiceChat(chatId) ? 'icon-192x192.png' : undefined,
    sentAt: toNotificationTimestamp(data.date),
  };
}

function getPushMessageBody(data: PushData, context: PushNotificationContext) {
  if (data.hasPreviewText) return data.description;

  const typeMatch = data.loc_key.match(MESSAGE_PUSH_TYPE_RE);
  const messageType = typeMatch?.[1] || typeMatch?.[2];
  if (!messageType || !checkIfMessagePushType(messageType)) return data.description;

  const messageText = context.messageTexts?.[messageType];
  if (messageText) return messageText;
  if (messageType === 'PHOTO') return context.photoText || context.messageText;
  if (messageType === 'VIDEO') return context.videoText || context.messageText;
  if (messageType === 'DOC') return context.fileText || context.messageText;
  return context.messageText;
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
  if (hasRestoredInbox && inboxUserId === notificationContext?.userId) return Promise.resolve();
  if (restorePromise) return restorePromise;

  restorePromise = (async () => {
    const saved = await waitForInboxStorage(
      PUSH_INBOX_STORE.get<{ userId?: string; entries: InboxEntry[]; deletedMessageKeys?: string[] }>(PUSH_INBOX_KEY),
    );
    inboxByChatKey.clear();
    shownNotifications.clear();
    deletedMessageKeys.clear();
    inboxUserId = notificationContext?.userId;
    hasRestoredInbox = true;
    if (saved && saved.userId !== inboxUserId) return;
    if (Array.isArray(saved?.deletedMessageKeys)) {
      saved.deletedMessageKeys.slice(-MAX_DELETED_MESSAGES).forEach((key) => {
        if (typeof key === 'string') deletedMessageKeys.add(key);
      });
    }
    const notifications = saved || !inboxUserId ? []
      : (await self.registration.getNotifications({ tag: APP_NOTIFICATION_TAG }))
        .filter((notification) => notification.data?.userId === inboxUserId);
    const latestNotification = notifications.reduce<Notification | undefined>((latest, current) => {
      return (current.data?.inboxUpdatedAt || 0) > (latest?.data?.inboxUpdatedAt || 0) ? current : latest || current;
    }, undefined);
    const stored = saved?.entries || latestNotification?.data?.entries;
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

function enqueueNotificationTask(task: () => Promise<unknown>) {
  const pendingTask = notificationQueue.then(task);
  notificationQueue = pendingTask.then(() => undefined, () => undefined);
  return pendingTask;
}

function saveInbox() {
  sanitizeStoredInbox();
  return waitForInboxStorage(PUSH_INBOX_STORE.set(PUSH_INBOX_KEY, {
    userId: inboxUserId,
    entries: Array.from(inboxByChatKey.values()),
    deletedMessageKeys: Array.from(deletedMessageKeys),
  }));
}

async function waitForInboxStorage<T>(task: Promise<T>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutTask = new Promise<undefined>((resolve) => {
    timeout = setTimeout(resolve, PUSH_STORAGE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([task, timeoutTask]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeStoredInbox() {
  inboxByChatKey.forEach((entry, key) => {
    if (checkIfCanShowPreview({ chatId: entry.chatId })) return;
    const preview = sanitizeNotification({ chatId: entry.chatId, title: entry.title, body: '', icon: entry.icon });
    const messages = getInboxMessages(entry).map((message) => ({ ...message, body: preview.body }));
    updateInboxMessages(key, { ...entry, title: preview.title, icon: preview.icon }, messages);
  });
}

function getInboxMessages(entry: InboxEntry): InboxMessage[] {
  if (entry.messages) return entry.messages;
  return entry.bodies.map((body, index) => ({
    body,
    messageId: index === entry.bodies.length - 1 ? entry.messageId : undefined,
    sentAt: index === entry.bodies.length - 1 ? entry.sentAt : undefined,
    eventKind: entry.eventKind || (entry.reaction ? 'reaction' : 'message'),
    storyId: entry.storyId,
    threadId: entry.threadId,
  }));
}

function getNotificationKey(notification: Pick<NotificationData,
  'chatId' | 'messageId' | 'storyId' | 'isReaction' | 'eventKind'>) {
  const eventKind = notification.eventKind || (notification.isReaction ? 'reaction' : 'message');
  return `${notification.chatId || '0'}:${eventKind}:${notification.storyId || notification.messageId || '0'}`;
}

function getDeletedMessageKey(chatId: string | undefined, messageId: number) {
  return !chatId || !isChannelId(chatId) ? `common:${messageId}` : `${chatId}:${messageId}`;
}

function checkIfMessageDeleted(notification: NotificationData) {
  const eventKind = notification.eventKind || (notification.isReaction ? 'reaction' : 'message');
  return (eventKind === 'message' || eventKind === 'reaction') && notification.messageId !== undefined
    && deletedMessageKeys.has(getDeletedMessageKey(notification.chatId, notification.messageId));
}

function rememberDeletedMessages(chatId: string | undefined, messageIds: Iterable<number>) {
  let hasChanged = false;
  for (const messageId of messageIds) {
    const key = getDeletedMessageKey(chatId, messageId);
    if (deletedMessageKeys.has(key)) continue;
    deletedMessageKeys.add(key);
    hasChanged = true;
  }
  while (deletedMessageKeys.size > MAX_DELETED_MESSAGES) {
    deletedMessageKeys.delete(deletedMessageKeys.values().next().value!);
  }
  return hasChanged;
}

function updateInboxMessages(key: string, entry: Omit<InboxEntry, 'bodies'>, messages: InboxMessage[]) {
  if (!messages.length) {
    inboxByChatKey.delete(key);
    return;
  }
  const latest = messages[messages.length - 1];
  inboxByChatKey.set(key, {
    ...entry,
    messages,
    bodies: messages.map((message) => message.body),
    messageId: latest.messageId,
    storyId: latest.storyId,
    threadId: latest.threadId,
    eventKind: latest.eventKind,
    reaction: latest.reaction,
    sentAt: messages.reduce<number | undefined>((sentAt, message) => latestSentAt(sentAt, message.sentAt), undefined),
  });
}

function rememberInboxEntry(notification: NotificationData) {
  const key = getInboxKey(notification.chatId);
  // A real sender replaces the closed-app "New message" row
  if (notification.chatId) {
    inboxByChatKey.delete(getInboxKey(undefined));
  }
  const previous = inboxByChatKey.get(key);
  const previousMessages = previous ? getInboxMessages(previous) : [];
  const eventKind = notification.eventKind || (notification.isReaction ? 'reaction' : 'message');
  const matchingIndex = previousMessages.findIndex((message) => {
    return (notification.messageId !== undefined || notification.storyId !== undefined)
      && message.messageId === notification.messageId && message.storyId === notification.storyId
      && message.eventKind === eventKind;
  });
  const isReaction = eventKind === 'reaction' || eventKind === 'storyReaction';
  if (matchingIndex >= 0 && !notification.editDate
    && (!isReaction || previousMessages[matchingIndex].body === notification.body)) {
    return false;
  }

  const shouldKeepMessagePosition = matchingIndex >= 0 && !isReaction;
  const originalSentAt = shouldKeepMessagePosition ? previousMessages[matchingIndex].sentAt : undefined;
  const message: InboxMessage = {
    body: notification.body,
    messageId: notification.messageId,
    storyId: notification.storyId,
    threadId: notification.threadId,
    editDate: notification.editDate,
    sentAt: originalSentAt ?? notification.sentAt ?? Date.now(),
    eventKind,
    reaction: notification.reaction,
  };
  if (shouldKeepMessagePosition) {
    previousMessages[matchingIndex] = message;
  } else {
    if (matchingIndex >= 0) previousMessages.splice(matchingIndex, 1);
    previousMessages.push(message);
    inboxByChatKey.delete(key);
  }
  const messages = previousMessages.slice(-MAX_LINES_PER_CHAT);
  updateInboxMessages(key, {
    chatId: notification.chatId,
    title: notification.title,
    icon: notification.icon || previous?.icon,
    isSilent: notification.isSilent,
    shouldReplaceHistory: notification.shouldReplaceHistory,
  }, messages);

  while (inboxByChatKey.size > MAX_INBOX_CHATS) {
    const oldestKey = inboxByChatKey.keys().next().value;
    if (!oldestKey) break;
    inboxByChatKey.delete(oldestKey);
  }

  return true;
}

function buildGroupedNotification(shouldAlert: boolean, incomingSentAt?: number) {
  sanitizeStoredInbox();
  const entries = Array.from(inboxByChatKey.values()).reverse()
    .sort((first, second) => (second.sentAt ?? 0) - (first.sentAt ?? 0));
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
  const sentAt = clampNotificationTimestamp(latestSentAt(newestSentAt, incomingSentAt));

  const options: AppNotificationOptions = {
    body,
    data: {
      chatId: onlyEntry?.chatId,
      messageId: onlyEntry?.messageId,
      reaction: onlyEntry?.reaction,
      count: messageCount,
      shouldReplaceHistory: onlyEntry?.shouldReplaceHistory,
      storyId: onlyEntry?.storyId,
      threadId: onlyEntry?.threadId,
      userId: inboxUserId,
      eventKind: onlyEntry?.eventKind,
      inboxUpdatedAt: Date.now(),
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
  if (!IS_SAFARI) {
    const notifications = await self.registration.getNotifications({ tag: APP_NOTIFICATION_TAG });
    notifications.forEach((notification) => notification.close());
  }

  if (!grouped) {
    logNotificationTrace(trace, 'skipEmptyInbox');
    return;
  }

  const { title, options } = grouped;
  return publishNotification(title, options, trace);
}

async function showDeletionNotification(userId: string, trace?: NotificationTrace) {
  notificationContext = await getPushNotificationContext();
  if (notificationContext?.userId !== userId || !notificationContext.hasWebNotifications) return;
  await restoreInbox();
  const body = notificationContext.controlMessages?.MESSAGE_DELETED || notificationContext.deletedMessageText;
  if (!body) return;
  await publishNotification(APP_NAME, {
    body,
    tag: APP_NOTIFICATION_TAG,
    icon: DEFAULT_NOTIFICATION_ICON,
    badge: DEFAULT_NOTIFICATION_ICON,
    silent: true,
    data: {
      userId,
      isDeletionNotice: true,
      inboxUpdatedAt: Date.now(),
      entries: Array.from(inboxByChatKey.values()),
    },
  }, trace);
}

async function publishNotification(title: string, options: NotificationOptions, trace?: NotificationTrace) {
  if (trace?.hasEmergencyNotificationRequestResolved) {
    logNotificationTrace(trace, 'skipNotificationAfterEmergency');
    return;
  }
  const notificationOptions: NotificationOptions = {
    ...options,
    data: { ...options.data, notificationInstanceId: crypto.randomUUID() },
  };
  logNotificationTrace(trace, 'showNotificationAttempt');
  try {
    await self.registration.showNotification(title, notificationOptions);
    logNotificationTrace(trace, 'showNotificationResolved');
    return;
  } catch (err) {
    logNotificationTrace(trace, 'showNotificationRejected', err);
  }

  if (trace?.hasEmergencyNotificationRequestResolved) {
    logNotificationTrace(trace, 'skipNotificationAfterEmergency');
    return;
  }

  // A rejected timestamp or `renotify` must not swallow the alert
  const fallbackOptions: NotificationOptions = { ...notificationOptions };
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

function showNotification(notification: NotificationData, trace?: NotificationTrace) {
  return enqueueNotificationTask(() => publishMessageNotification(notification, trace));
}

async function showPageNotification(
  notification: NotificationData, shouldWaitForPush: boolean, trace: NotificationTrace,
) {
  if (shouldWaitForPush) {
    logNotificationTrace(trace, 'waitingForPushPreview');
    pendingPageNotifications.add(notification);
    // The grace period runs outside the queue so a push can publish immediately
    await waitFor(PAGE_PUSH_WAIT_MS);
  }
  return enqueueNotificationTask(async () => {
    if (shouldWaitForPush && !pendingPageNotifications.delete(notification)) {
      logNotificationTrace(trace, 'skipCancelledPageNotification');
      return;
    }
    await publishMessageNotification(notification, trace);
    if (trace.hasNotificationRequestResolved) shownNotifications.add(getNotificationKey(notification));
  });
}

async function publishMessageNotification(notification: NotificationData, trace?: NotificationTrace) {
  const { userId } = notification;
  notificationContext = await getPushNotificationContext();
  if (!userId || !notificationContext?.userId) {
    logNotificationTrace(trace, userId ? 'skipAccountContextUnavailable' : 'skipMissingAccount');
    if (trace?.source === 'push') await showUnscopedPushNotification(trace);
    return;
  }
  if (userId !== notificationContext.userId) {
    logNotificationTrace(trace, 'skipOtherAccount');
    return;
  }
  notification = sanitizeNotification(notification, trace);
  logNotificationTrace(trace, 'restoringInbox');
  await restoreInbox();
  if (checkIfMessageDeleted(notification)) {
    logNotificationTrace(trace, 'skipDeletedMessage');
    if (IS_SAFARI && trace?.source === 'push') await showDeletionNotification(userId, trace);
    return;
  }
  const hadWakeRow = inboxByChatKey.has(getInboxKey(undefined));
  if (!rememberInboxEntry(notification)) {
    // A duplicate preview still replaces the closed-app "New message" row
    if (hadWakeRow && notification.chatId) {
      await saveInbox();
      if (IS_SAFARI && trace?.source === 'push') return showDuplicatePushNotification(notification, trace);
      if (!IS_SAFARI) await publishInbox(false, undefined, trace);
      else logNotificationTrace(trace, 'skipDuplicateInboxEntry');
    } else if (IS_SAFARI && trace?.source === 'push') {
      return showDuplicatePushNotification(notification, trace);
    } else {
      logNotificationTrace(trace, 'skipDuplicateInboxEntry');
    }
    return undefined;
  }

  await saveInbox();
  const shouldAlert = !notification.isReaction && !notification.isSilent;
  // TODO Update condition when reaction badges are implemented
  const soundTask = shouldAlert
    ? playNotificationSound(String(notification.messageId) || notification.chatId || '')
    : undefined;
  const notificationTask = IS_SAFARI
    ? publishSingleNotification(notification, shouldAlert, trace)
    : publishInbox(shouldAlert, notification.sentAt, trace);
  if (trace) trace.notificationTask = notificationTask;

  return Promise.all([soundTask, notificationTask]);
}

async function showDuplicatePushNotification(notification: NotificationData, trace: NotificationTrace) {
  notificationContext = await getPushNotificationContext();
  await restoreInbox();
  if (notification.userId && notification.userId === notificationContext?.userId
    && checkIfMessageDeleted(notification)) {
    logNotificationTrace(trace, 'skipDeletedMessage');
    return showDeletionNotification(notification.userId, trace);
  }
  logNotificationTrace(trace, 'duplicatePushNotificationRequested');
  if (notification.userId === inboxUserId && notification.chatId) inboxByChatKey.delete(getInboxKey(undefined));
  await saveInbox();
  return showGenericPushNotification(trace);
}

function sanitizeNotification(notification: NotificationData, trace?: NotificationTrace): NotificationData {
  const previewHiddenReason = getPreviewHiddenReason(notification, notificationContext);
  if (trace) trace.previewHiddenReason = previewHiddenReason;
  if (!previewHiddenReason) return notification;
  logNotificationTrace(trace, 'notificationPreviewHidden');
  return {
    ...notification,
    title: APP_NAME,
    body: notificationContext?.messageText || '',
    icon: undefined,
  };
}

function checkIfCanShowPreview(notification: Pick<NotificationData, 'chatId' | 'shouldHidePreview'>) {
  return !getPreviewHiddenReason(notification, notificationContext);
}

function getPreviewHiddenReason(
  notification: Pick<NotificationData, 'chatId' | 'shouldHidePreview'>, context?: PushNotificationContext,
): PushPreviewHiddenReason | undefined {
  if (!context) return 'contextUnavailable';
  if (!context.hasWebNotifications) return 'notificationsDisabled';
  if (context.isScreenLocked) return 'screenLocked';
  if (context.hasPasscode) return 'passcodeEnabled';
  if (notification.shouldHidePreview) return 'privatePush';
  if (!notification.chatId) return 'missingChat';
  const shouldShowPreviews = context.shouldShowPreviewsByChatId[notification.chatId];
  if (shouldShowPreviews === undefined) return 'missingChatSettings';
  if (!shouldShowPreviews) return 'chatPreviewsDisabled';
  return undefined;
}

function publishSingleNotification(notification: NotificationData, shouldAlert: boolean, trace?: NotificationTrace) {
  notification = sanitizeNotification(notification, trace);
  const options: NotificationOptions = {
    body: notification.body,
    data: {
      chatId: notification.chatId,
      messageId: notification.messageId,
      reaction: notification.reaction,
      shouldReplaceHistory: notification.shouldReplaceHistory,
      storyId: notification.storyId,
      threadId: notification.threadId,
      userId: inboxUserId,
      eventKind: notification.eventKind || (notification.isReaction ? 'reaction' : 'message'),
      inboxUpdatedAt: Date.now(),
      count: 1,
      entries: Array.from(inboxByChatKey.values()),
    },
    icon: notification.icon || DEFAULT_NOTIFICATION_ICON,
    badge: DEFAULT_NOTIFICATION_ICON,
    tag: APP_NOTIFICATION_TAG,
    silent: !shouldAlert,
  };
  const notificationTask = publishNotification(notification.title, options, trace);
  if (trace) trace.notificationTask = notificationTask;
  return notificationTask;
}

async function closeNotifications({
  userId,
  threadId,
  chatId,
  lastReadInboxMessageId,
}: CloseNotificationData, trace?: NotificationTrace) {
  // Only an inbox read cursor dismisses the alert
  if (!lastReadInboxMessageId) return;

  return enqueueNotificationTask(() => removeInboxNotifications(chatId, (message) => {
    return message.eventKind === 'message'
      && (threadId === undefined || message.threadId === threadId)
      && (message.messageId === undefined || message.messageId <= lastReadInboxMessageId);
  }, trace, userId));
}

function checkIfNotificationChatMatches(chatId: string | undefined, notificationChatId?: string) {
  if (!notificationChatId) return false;
  if (chatId) return notificationChatId === chatId;
  // Private chats and basic groups share an account-wide message ID sequence
  return !isChannelId(notificationChatId);
}

async function removeInboxNotifications(
  chatId: string | undefined,
  shouldRemove: (message: InboxMessage) => boolean,
  trace?: NotificationTrace,
  userId?: string,
  deletedMessageIds?: Iterable<number>,
) {
  notificationContext = await getPushNotificationContext();
  if (!userId || userId !== notificationContext?.userId) {
    logNotificationTrace(trace, 'skipOtherAccount');
    return;
  }
  pendingPageNotifications.forEach((notification) => {
    if (notification.userId === userId && checkIfNotificationChatMatches(chatId, notification.chatId)
      && shouldRemove({
        ...notification,
        eventKind: notification.eventKind || (notification.isReaction ? 'reaction' : 'message'),
      })) {
      pendingPageNotifications.delete(notification);
    }
  });
  await restoreInbox();
  const shouldNotifyAboutDeletion = Boolean(deletedMessageIds);
  const hasDeletedMessagesChanged = deletedMessageIds ? rememberDeletedMessages(chatId, deletedMessageIds) : false;
  let hasChanged = false;
  inboxByChatKey.forEach((entry, key) => {
    if (!checkIfNotificationChatMatches(chatId, entry.chatId)) return;
    const messages = getInboxMessages(entry);
    const nextMessages = messages.filter((message) => !shouldRemove(message));
    if (nextMessages.length === messages.length) return;
    hasChanged = true;
    messages.filter(shouldRemove).forEach((message) => {
      shownNotifications.delete(getNotificationKey({ ...message, chatId: entry.chatId }));
    });
    updateInboxMessages(key, entry, nextMessages);
  });
  if (hasChanged || hasDeletedMessagesChanged) {
    await saveInbox();
  }
  if (hasChanged) logNotificationTrace(trace, 'inboxUpdated');
  if (!hasChanged) logNotificationTrace(trace, 'noMatchingInboxMessages');
  if (!IS_SAFARI) {
    if (hasChanged) await publishInbox(false, undefined, trace);
    if (shouldNotifyAboutDeletion && !inboxByChatKey.size && (hasChanged || trace?.source === 'push')) {
      await showDeletionNotification(userId, trace);
    }
    return;
  }
  const notifications = await self.registration.getNotifications({ tag: APP_NOTIFICATION_TAG });
  const pendingCloses: PendingNotificationClose[] = [];
  notifications.forEach((notification) => {
    const data = notification.data;
    if (data?.userId !== userId || !Number.isFinite(data.inboxUpdatedAt) || data.isDeletionNotice
      || !checkIfNotificationMatches(notification, chatId, shouldRemove)) return;
    const closeAt = data.inboxUpdatedAt + SAFARI_NOTIFICATION_LIFETIME_MS;
    if (Date.now() < closeAt) {
      pendingCloses.push({
        userId,
        instanceId: data.notificationInstanceId,
        notificationKey: getNotificationKey(data),
        shownAt: data.inboxUpdatedAt,
        closeAt,
      });
      return;
    }
    notification.close();
  });
  if (pendingCloses.length) await deferNotificationCloses(pendingCloses, trace);
  if (shouldNotifyAboutDeletion && hasChanged) await showDeletionNotification(userId, trace);
}

function checkIfNotificationMatches(
  notification: Notification, chatId: string | undefined, shouldRemove: (message: InboxMessage) => boolean,
) {
  const data = notification.data;
  if (data.chatId) {
    return checkIfNotificationChatMatches(chatId, data.chatId) && shouldRemove({
      body: notification.body,
      messageId: data.messageId,
      storyId: data.storyId,
      threadId: data.threadId,
      eventKind: data.eventKind || 'message',
    });
  }
  return Array.isArray(data.entries) && data.entries.some((entry: unknown) => isInboxEntry(entry)
    && checkIfNotificationChatMatches(chatId, entry.chatId) && getInboxMessages(entry).some(shouldRemove));
}

async function deferNotificationCloses(closes: PendingNotificationClose[], trace?: NotificationTrace) {
  const pendingCloses = await loadPendingNotificationCloses();
  closes.forEach((close) => {
    if (pendingCloses.some((pending) => pending.userId === close.userId
      && pending.instanceId === close.instanceId
      && pending.notificationKey === close.notificationKey && pending.shownAt === close.shownAt)) return;
    pendingCloses.push(close);
  });
  await waitForInboxStorage(PUSH_INBOX_STORE.set(
    PENDING_NOTIFICATION_CLOSES_KEY, pendingCloses.slice(-MAX_PENDING_NOTIFICATION_CLOSES),
  ));
  logNotificationTrace(trace, 'notificationCleanupDeferred');
}

async function processPendingNotificationCloses(trace?: NotificationTrace) {
  clearTimeout(notificationCleanupTimer);
  notificationCleanupTimer = undefined;
  const pendingCloses = await loadPendingNotificationCloses();
  if (!pendingCloses.length) return;
  const notifications = await self.registration.getNotifications({ tag: APP_NOTIFICATION_TAG });
  const remainingCloses: PendingNotificationClose[] = [];
  pendingCloses.forEach((close) => {
    const matching = notifications.filter((notification) => notification.data?.userId === close.userId
      && !notification.data.isDeletionNotice
      && notification.data.notificationInstanceId === close.instanceId
      && notification.data.inboxUpdatedAt === close.shownAt
      && getNotificationKey(notification.data) === close.notificationKey);
    if (!matching.length) return;
    if (Date.now() < close.closeAt) {
      remainingCloses.push(close);
      return;
    }
    matching.forEach((notification) => notification.close());
    logNotificationTrace(trace, 'notificationCleanupRequested');
  });
  await waitForInboxStorage(PUSH_INBOX_STORE.set(PENDING_NOTIFICATION_CLOSES_KEY, remainingCloses));
  if (!remainingCloses.length) return;
  const cleanupAt = Math.min(...remainingCloses.map((close) => close.closeAt));
  notificationCleanupTimer = setTimeout(() => {
    const cleanupTrace = createNotificationTrace('cleanupMessageNotifications');
    void trackNotificationTask(
      enqueueNotificationTask(() => processPendingNotificationCloses(cleanupTrace)), cleanupTrace,
    ).catch(() => undefined);
  }, Math.max(0, cleanupAt - Date.now()));
  const clients = await getClients();
  clients.forEach((client) => client.postMessage({ type: 'scheduleNotificationCleanup', payload: { cleanupAt } }));
}

async function loadPendingNotificationCloses() {
  const saved = await waitForInboxStorage(PUSH_INBOX_STORE.get<unknown>(PENDING_NOTIFICATION_CLOSES_KEY));
  return Array.isArray(saved) ? saved.filter(isPendingNotificationClose).slice(-MAX_PENDING_NOTIFICATION_CLOSES) : [];
}

function isPendingNotificationClose(value: unknown): value is PendingNotificationClose {
  if (!value || typeof value !== 'object') return false;
  const close = value as PendingNotificationClose;
  return typeof close.userId === 'string' && typeof close.notificationKey === 'string'
    && (close.instanceId === undefined || typeof close.instanceId === 'string')
    && Number.isFinite(close.shownAt) && Number.isFinite(close.closeAt)
    && close.closeAt >= close.shownAt + SAFARI_NOTIFICATION_LIFETIME_MS;
}

function deleteMessageNotifications(
  { chatId, messageIds, userId }: { chatId?: string; messageIds: number[]; userId?: string }, trace?: NotificationTrace,
) {
  const deletedIds = new Set(messageIds);
  logNotificationTrace(trace, chatId ? 'chatDeletionReceived' : 'commonBoxDeletionReceived');
  return enqueueNotificationTask(() => removeInboxNotifications(chatId, (message) => {
    return (message.eventKind === 'message' || message.eventKind === 'reaction')
      && (message.messageId === undefined ? Boolean(chatId) : deletedIds.has(message.messageId));
  }, trace, userId, messageIds));
}

function updateMessageNotification(notification: NotificationData, trace?: NotificationTrace) {
  return enqueueNotificationTask(async () => {
    notificationContext = await getPushNotificationContext();
    if (!notification.userId || notification.userId !== notificationContext?.userId) return;
    notification = sanitizeNotification(notification, trace);
    pendingPageNotifications.forEach((pendingNotification) => {
      if (pendingNotification.userId === notification.userId && pendingNotification.chatId === notification.chatId
        && pendingNotification.messageId === notification.messageId) {
        pendingNotification.title = notification.title;
        pendingNotification.body = notification.body;
        pendingNotification.icon = notification.icon;
      }
    });
    await restoreInbox();
    const key = getInboxKey(notification.chatId);
    const entry = inboxByChatKey.get(key);
    if (!entry) return;
    let hasChanged = false;
    const messages = getInboxMessages(entry).map((message) => {
      if (message.eventKind !== 'message' || message.messageId !== notification.messageId) return message;
      hasChanged = true;
      return { ...message, body: notification.body, editDate: notification.editDate };
    });
    if (!hasChanged) return;
    updateInboxMessages(key, { ...entry, title: notification.title, icon: notification.icon }, messages);
    await saveInbox();
    const notifications = await self.registration.getNotifications({ tag: APP_NOTIFICATION_TAG });
    if (!notifications.length) return;
    if (IS_SAFARI) {
      if (notifications.some((current) => current.data?.userId === notification.userId
        && current.data?.chatId === notification.chatId
        && current.data?.messageId === notification.messageId)) {
        await publishSingleNotification(notification, false, trace);
      }
      return;
    }
    await publishInbox(false, undefined, trace);
  });
}

async function checkIfAppIsVisible(trace?: NotificationTrace) {
  const clients = await getClients();
  const isAppVisible = clients.some((client) => client.visibilityState === 'visible');
  if (trace) {
    recordPushDiagnosticStep(trace.diagnostic, 'clientVisibility', { isAppVisible });
  }
  return isAppVisible;
}

async function showPushPreview(notification: NotificationData, trace?: NotificationTrace) {
  // Safari requires a visible notification for the push even when a window is open
  if (!IS_SAFARI && await checkIfAppIsVisible(trace)) {
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

function dismissChatlessNotification(trace?: NotificationTrace) {
  return enqueueNotificationTask(async () => {
    notificationContext = await getPushNotificationContext();
    await restoreInbox();
    const key = getInboxKey(undefined);
    if (!inboxByChatKey.has(key)) return;
    inboxByChatKey.delete(key);
    await saveInbox();
    if (!IS_SAFARI) await publishInbox(false, undefined, trace);
  });
}

export function handlePush(e: PushEvent) {
  const trace = createNotificationTrace('push');
  logNotificationTrace(trace, 'pushReceived');
  const raw = readPushRaw(e, trace);

  e.waitUntil(trackNotificationTask(processPush(raw, trace), trace));
}

async function processPush(raw: unknown, trace: NotificationTrace) {
  const context = await getPushNotificationContext();
  logNotificationTrace(trace, 'readingPayload');
  const payload = await decryptFcmPush(raw, trace);
  logNotificationTrace(trace, 'payloadReady');
  const data = rawToPushData(payload);
  trace.hasPayloadUserId = Boolean(data.user_id);
  trace.hasAccountContext = Boolean(context?.userId);
  trace.hasPayloadPreviewText = Boolean(data.hasPreviewText);
  if (data.user_id && trace.authenticatedUserId && data.user_id !== trace.authenticatedUserId) {
    logNotificationTrace(trace, 'skipRegisteredAccountMismatch');
    return;
  }
  if (!data.user_id && trace.authenticatedUserId) {
    data.user_id = trace.authenticatedUserId;
    logNotificationTrace(trace, 'pushAccountResolvedFromRegistration');
  }
  if (data.user_id && context?.userId && data.user_id !== context.userId) {
    logNotificationTrace(trace, 'skipOtherAccount');
    return;
  }
  // A badge-only push carries no message; the open app or a preview push shows that message
  if (isBadgeOnlyPush(payload)) {
    if (data.user_id && data.user_id === context?.userId) await updateAppBadge(data.badge, trace);
    logNotificationTrace(trace, 'skipBadgeOnly');
    return undefined;
  }

  const notificationType = data.loc_key;
  trace.notificationType = typeof notificationType === 'string' && PUSH_NOTIFICATION_TYPE_RE.test(notificationType)
    ? notificationType : undefined;
  logNotificationTrace(trace, 'payloadClassified');
  const isControlPush = checkIfControlPush(data.loc_key);

  if (!data.user_id || !context?.userId) {
    logNotificationTrace(trace, data.user_id ? 'skipAccountContextUnavailable' : 'skipMissingAccount');
    if (!isControlPush && !HIDDEN_SERVICE_LOC_KEYS.has(data.loc_key)
      && data.mute !== PUSH_FLAG_TRUE) {
      await enqueueNotificationTask(() => showUnscopedPushNotification(trace));
    }
    return;
  }
  trace.recipientUserId = data.user_id;
  await updateAppBadge(data.badge, trace);

  if (isControlPush) {
    if (!data.user_id) {
      logNotificationTrace(trace, 'skipUnscopedControl');
      return;
    }
    await handleControlPush(data, trace);
    return;
  }

  // Do not show muted notifications
  if (!data || data.mute === PUSH_FLAG_TRUE) {
    logNotificationTrace(trace, data ? 'skipMuted' : 'skipMissingData');
    return undefined;
  }

  const notification = getNotificationData(data, context, trace);
  if (notification.chatId) {
    const shouldShowPreviews = context.shouldShowPreviewsByChatId[notification.chatId];
    if (shouldShowPreviews === undefined) {
      logNotificationTrace(trace, 'previewSettingsUnavailable');
    } else if (!shouldShowPreviews) {
      logNotificationTrace(trace, 'previewDisabledForChat');
    }
  }

  // Login and data-center pushes come from the hidden service account
  if (HIDDEN_SERVICE_LOC_KEYS.has(data.loc_key)) {
    lastPreviewPushAt = Date.now();
    await notifyClientsOfPushState(data.loc_key, data.user_id);
    logNotificationTrace(trace, 'skipServiceMessage');
    return undefined;
  }

  if (
    notification.chatId && (isChatHidden(notification.chatId) || isInternalChat(notification.chatId))
    && !isAdsPlatformLoginText(data.description)
  ) {
    logNotificationTrace(trace, 'skipHiddenChat');
    return undefined;
  }

  if (context?.hasWebNotifications === false) {
    logNotificationTrace(trace, 'skipNotificationsDisabled');
    return;
  }

  if (notification.editDate) {
    return updateMessageNotification(notification, trace);
  }

  if (data.loc_key === 'PHONE_CALL_REQUEST' || data.loc_key === 'PHONE_CALL_MISSED'
    || data.loc_key === 'CONF_CALL_MISSED') {
    return enqueueNotificationTask(async () => {
      notificationContext = await getPushNotificationContext();
      if (!data.user_id || data.user_id !== notificationContext?.userId) return;
      const preview = sanitizeNotification(getNotificationData(data, notificationContext, trace), trace);
      const notificationTask = publishNotification(
        data.loc_key === 'PHONE_CALL_REQUEST' ? notificationContext?.incomingCallText || APP_NAME : APP_NAME,
        {
          body: preview.body,
          icon: DEFAULT_NOTIFICATION_ICON,
          tag: `call_${data.custom.call_id || data.random_id}`,
          data: { callId: data.custom.call_id, userId: notificationContext?.userId },
          silent: preview.isSilent,
        }, trace,
      );
      if (trace) trace.notificationTask = notificationTask;
      return notificationTask;
    });
  }

  // A push without a sender can carry text, or just wake the app for a later preview
  if (!notification.chatId) {
    if (data.description && data.description !== GENERIC_PUSH_DESCRIPTION
      && data.description !== context?.messageText) {
      lastPreviewPushAt = Date.now();
      return showPushPreview(notification, trace);
    }
    return showWakeWhenAppIsClosed(notification, trace);
  }

  lastPreviewPushAt = Date.now();

  // The page can request a message notification before its push arrives
  const notificationKey = getNotificationKey(notification);
  if (shownNotifications.has(notificationKey)) {
    shownNotifications.delete(notificationKey);
    if (IS_SAFARI && trace?.source === 'push') {
      return enqueueNotificationTask(() => showDuplicatePushNotification(notification, trace));
    }
    logNotificationTrace(trace, 'skipAlreadyShown');
    return dismissChatlessNotification(trace);
  }

  return showPushPreview(notification, trace);
}

async function updateAppBadge(value: PushData['badge'], trace?: NotificationTrace) {
  if (value === undefined || !/^\d+$/.test(String(value))) return;
  const count = Number(value);
  if (!Number.isSafeInteger(count)) return;
  try {
    if (!count && 'clearAppBadge' in self.navigator) {
      await self.navigator.clearAppBadge();
    } else if ('setAppBadge' in self.navigator) {
      await self.navigator.setAppBadge(count);
    }
  } catch (err) {
    logNotificationTrace(trace, 'badgeUpdateFailed', err);
  }
}

async function handleControlPush(data: PushData, trace?: NotificationTrace) {
  logNotificationTrace(trace, 'controlPushReceived');
  if (data.loc_key === 'MESSAGE_DELETED') {
    if (data.custom.channel_id) {
      logNotificationTrace(trace, 'channelDeletionPushReceived');
    } else if (data.custom.chat_id) {
      logNotificationTrace(trace, 'basicGroupDeletionPushReceived');
    } else if (data.custom.from_id) {
      logNotificationTrace(trace, 'privateDeletionPushReceived');
    } else {
      logNotificationTrace(trace, 'unscopedDeletionPushReceived');
    }
  }
  const chatId = getChatId(data);
  const messageIds = new Set(parsePushIds(data.custom.messages));
  const storyIds = new Set(parsePushIds(data.custom.story_id));
  const maxId = parsePushId(data.custom.max_id);
  const threadId = parsePushId(data.custom.topic_id || data.custom.top_msg_id);
  if (chatId) {
    await enqueueNotificationTask(() => removeInboxNotifications(chatId, (message) => {
      if (threadId && message.threadId !== threadId) return false;
      switch (data.loc_key) {
        case 'READ_HISTORY':
          return Boolean(maxId && message.eventKind === 'message'
            && (message.messageId === undefined || message.messageId <= maxId));
        case 'READ_REACTION':
          return message.eventKind === 'reaction' && messageIds.size > 0
            && (message.messageId === undefined || messageIds.has(message.messageId));
        case 'MESSAGE_DELETED':
          return (message.eventKind === 'message' || message.eventKind === 'reaction') && messageIds.size > 0
            && (message.messageId === undefined || messageIds.has(message.messageId));
        case 'READ_STORIES':
          return Boolean(maxId && (message.eventKind === 'story' || message.eventKind === 'storyReaction')
            && (message.storyId === undefined || message.storyId <= maxId));
        case 'STORY_DELETED':
          return (message.eventKind === 'story' || message.eventKind === 'storyReaction') && storyIds.size > 0
            && (message.storyId === undefined || storyIds.has(message.storyId));
        default:
          return false;
      }
    }, trace, data.user_id, data.loc_key === 'MESSAGE_DELETED' ? messageIds : undefined));
  }
  if (data.loc_key !== 'SESSION_REVOKE' || (trace?.isPayloadAuthenticated && data.user_id)) {
    await notifyClientsOfPushState(data.loc_key, data.user_id);
  }
}

async function notifyClientsOfPushState(notificationType: string, userId?: string) {
  const clients = await getClients();
  clients.forEach((client) => client.postMessage({
    type: 'pushStateUpdate',
    payload: { notificationType, userId },
  }));
}

// FCM pushes registered with a `secret` carry the Telegram payload encrypted in `data.p`
async function decryptFcmPush(raw: unknown, trace: NotificationTrace) {
  if (!raw || typeof raw !== 'object' || !isFcmEnvelope(raw)) return raw;
  const encoded = (raw as { data: { p?: unknown } }).data.p;
  if (typeof encoded !== 'string') return raw;

  try {
    const registeredSecret = await loadRegisteredPushSecret();
    const registeredPayload = registeredSecret
      ? await decryptTelegramPush(encoded, registeredSecret.secret) : undefined;
    if (registeredPayload) {
      trace.isPayloadAuthenticated = true;
      trace.authenticatedUserId = registeredSecret!.userId;
      logNotificationTrace(trace, 'payloadDecrypted');
      return registeredPayload;
    }
    const secret = await loadPushSecret();
    const payload = secret ? await decryptTelegramPush(encoded, secret) : undefined;
    trace.isPayloadAuthenticated = Boolean(payload);
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
      type: data.storyId ? 'focusStory' : 'focusMessage',
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
  const data = e.notification.data || {};
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
  if (IS_SAFARI && (e.data.type === 'clientReady' || e.data.type === 'cleanupMessageNotifications')) {
    const trace = createNotificationTrace('cleanupMessageNotifications');
    e.waitUntil(trackNotificationTask(enqueueNotificationTask(() => processPendingNotificationCloses(trace)), trace));
  }
  if (e.data.type === 'showMessageNotification') {
    const trace = createNotificationTrace('showMessageNotification');
    logNotificationTrace(trace, 'clientMessageReceived');
    const notification: NotificationData = e.data.payload;
    const shouldWaitForPush = IS_SAFARI && e.data.shouldWaitForPush === true;
    e.waitUntil(trackNotificationTask(showPageNotification(notification, shouldWaitForPush, trace), trace));
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

  if (e.data.type === 'deleteMessageNotifications') {
    const trace = createNotificationTrace('deleteMessageNotifications');
    logNotificationTrace(trace, 'clientMessageReceived');
    e.waitUntil(trackNotificationTask(deleteMessageNotifications(e.data.payload, trace), trace));
  }

  if (e.data.type === 'updateMessageNotification') {
    const trace = createNotificationTrace('updateMessageNotification');
    logNotificationTrace(trace, 'clientMessageReceived');
    e.waitUntil(trackNotificationTask(updateMessageNotification(e.data.payload, trace), trace));
  }
}

function createNotificationTrace(source: NotificationTrace['source']): NotificationTrace {
  lastNotificationTraceId += 1;
  return { id: lastNotificationTraceId, source, diagnostic: createPushDiagnosticTrace(source) };
}

async function trackNotificationTask(task: Promise<unknown>, trace?: NotificationTrace) {
  if (!trace) return task;
  const processingTask = processNotificationTask(task, trace);
  try {
    if (IS_SAFARI && trace.source === 'push') {
      await ensurePushNotification(processingTask, trace);
    }
    return await processingTask;
  } finally {
    if (trace.source === 'push') {
      trace.hasNotificationRequestResolved ??= false;
      logNotificationTrace(trace, trace.hasNotificationRequestResolved
        ? 'pushNotificationRequestResolved' : 'pushCompletedWithoutNotification');
    }
    await flushPushDiagnosticTrace(trace.diagnostic);
  }
}

async function processNotificationTask(task: Promise<unknown>, trace: NotificationTrace) {
  try {
    const result = await task;
    logNotificationTrace(trace, 'processingCompleted');
    return result;
  } catch (err) {
    logNotificationTrace(trace, 'processingFailed', err);
    if (!IS_SAFARI || trace.source !== 'push') throw err;
    return undefined;
  } finally {
    // A sound failure can settle processing before the notification request finishes
    await trace.notificationTask?.catch(() => undefined);
    if (IS_SAFARI && trace.source === 'push' && !trace.hasNotificationRequestResolved) {
      await enqueueNotificationTask(() => showGenericPushNotification(trace));
    }
    if (IS_SAFARI && trace.source !== 'cleanupMessageNotifications') {
      await enqueueNotificationTask(() => processPendingNotificationCloses(trace))
        .catch((err: unknown) => logNotificationTrace(trace, 'notificationCleanupFailed', err));
    }
  }
}

async function ensurePushNotification(task: Promise<unknown>, trace: NotificationTrace) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const notificationTask = new Promise<void>((resolve) => {
    trace.resolveNotificationRequest = resolve;
  });
  const timeoutTask = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      logNotificationTrace(trace, 'pushNotificationDeadlineExceeded');
      resolve();
    }, SAFARI_PUSH_FALLBACK_DELAY_MS);
  });

  try {
    await Promise.race([notificationTask, task.catch(() => undefined), timeoutTask]);
  } finally {
    clearTimeout(timeout);
    trace.resolveNotificationRequest = undefined;
  }
  if (trace.hasNotificationRequestResolved) return;

  // The emergency card has no storage, queue, resource, or account dependencies
  logNotificationTrace(trace, 'emergencyPushNotificationRequested');
  logNotificationTrace(trace, 'showNotificationAttempt');
  try {
    await self.registration.showNotification(APP_NAME, { tag: APP_NOTIFICATION_TAG, silent: true });
    trace.hasEmergencyNotificationRequestResolved = true;
    logNotificationTrace(trace, 'showNotificationResolved');
  } catch (err) {
    logNotificationTrace(trace, 'showNotificationRejected', err);
  } finally {
    await flushPushDiagnosticTrace(trace.diagnostic);
  }
}

async function showGenericPushNotification(trace: NotificationTrace) {
  notificationContext = await getPushNotificationContext();
  await restoreInbox().catch(() => undefined);
  logNotificationTrace(trace, 'genericPushNotificationRequested');
  const notificationType = trace.notificationType;
  let body: string | undefined;
  if (trace.recipientUserId && trace.recipientUserId === notificationContext?.userId
    && notificationType && checkIfControlPush(notificationType)
    && (notificationType !== 'SESSION_REVOKE' || trace.isPayloadAuthenticated)) {
    body = notificationContext.controlMessages?.[notificationType];
    if (!body && notificationType === 'MESSAGE_DELETED') {
      body = notificationContext.deletedMessageText;
    }
  }
  await publishNotification(APP_NAME, {
    tag: APP_NOTIFICATION_TAG,
    body,
    icon: DEFAULT_NOTIFICATION_ICON,
    badge: DEFAULT_NOTIFICATION_ICON,
    silent: true,
    data: {
      userId: inboxUserId,
      isDeletionNotice: notificationType === 'MESSAGE_DELETED' || undefined,
      inboxUpdatedAt: Date.now(),
      entries: Array.from(inboxByChatKey.values()),
    },
  }, trace);
}

async function showUnscopedPushNotification(trace: NotificationTrace) {
  const context = await getPushNotificationContext();
  if (context?.hasWebNotifications === false) {
    logNotificationTrace(trace, 'skipNotificationsDisabled');
    return;
  }
  logNotificationTrace(trace, 'unscopedPushNotificationRequested');
  await publishNotification(APP_NAME, {
    tag: UNSCOPED_NOTIFICATION_TAG,
    body: context?.messageText,
    icon: DEFAULT_NOTIFICATION_ICON,
    badge: DEFAULT_NOTIFICATION_ICON,
    silent: true,
  }, trace);
}

function logNotificationTrace(trace: NotificationTrace | undefined, status: string, err?: unknown) {
  if (!trace) return;
  if (status === 'showNotificationResolved' || status === 'showNotificationRetryResolved') {
    trace.hasNotificationRequestResolved = true;
    trace.resolveNotificationRequest?.();
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
    previewHiddenReason: trace.previewHiddenReason,
    hasPayloadPreviewText: trace.hasPayloadPreviewText,
    hasPayloadUserId: trace.hasPayloadUserId,
    hasAccountContext: trace.hasAccountContext,
    isPayloadAuthenticated: trace.isPayloadAuthenticated,
    hasRegisteredSecretOwner: Boolean(trace.authenticatedUserId),
  };
  recordPushDiagnosticStep(trace.diagnostic, status, details);
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('[SW] Notification trace', { id: trace.id, source: trace.source, status, ...details });
  }
}
