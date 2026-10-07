import { APP_NAME, DEBUG, DEBUG_MORE } from '../config';
import { isChatHidden } from '../util/hiddenChats';
import { isInternalChat } from '../util/internalChats';
import { includesAdsTelegramOrg, isOfficialTelegramServiceChat, JUST_CHAT_TITLE } from '../util/officialTelegramAds';

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
const SECONDS_TO_MS = 1000;
const UNIX_MS_THRESHOLD = 1e12;

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

const inboxByChatKey = new Map<string, InboxEntry>();
const shownNotifications = new Set();
const clickBuffer: Record<string, NotificationData> = {};

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

function earliestSentAt(current?: number, next?: number) {
  if (current === undefined) return next;
  if (next === undefined) return current;
  return Math.min(current, next);
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

function rememberInboxEntry(notification: NotificationData) {
  const key = getInboxKey(notification.chatId);
  const previous = inboxByChatKey.get(key);
  if (previous && notification.messageId && previous.messageId === notification.messageId) {
    return;
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
    sentAt: earliestSentAt(previous?.sentAt, notification.sentAt),
  });

  while (inboxByChatKey.size > MAX_INBOX_CHATS) {
    const oldestKey = inboxByChatKey.keys().next().value;
    if (!oldestKey) break;
    inboxByChatKey.delete(oldestKey);
  }
}

function listInboxEntries() {
  return Array.from(inboxByChatKey.values()).reverse();
}

function buildGroupedNotification(shouldAlert: boolean) {
  const entries = listInboxEntries();
  const onlyEntry = entries.length === 1 ? entries[0] : undefined;
  const title = onlyEntry ? onlyEntry.title : APP_NAME;
  const body = onlyEntry
    ? onlyEntry.bodies.join('\n')
    : entries.map((entry) => {
      const latestBody = entry.bodies[entry.bodies.length - 1];
      return `${entry.title}: ${latestBody}`;
    }).join('\n');
  const messageCount = entries.reduce((sum, entry) => sum + entry.bodies.length, 0);
  const sentAt = entries.reduce<number | undefined>(
    (oldest, entry) => earliestSentAt(oldest, entry.sentAt),
    undefined,
  );

  const options: NotificationOptions = {
    body,
    data: {
      chatId: onlyEntry?.chatId,
      messageId: onlyEntry?.messageId,
      reaction: onlyEntry?.reaction,
      count: messageCount,
      shouldReplaceHistory: onlyEntry?.shouldReplaceHistory,
    },
    icon: onlyEntry?.icon || 'icon-192x192.png',
    badge: 'icon-192x192.png',
    tag: APP_NOTIFICATION_TAG,
    silent: !shouldAlert,
    timestamp: sentAt,
  };

  if (shouldAlert) {
    // @ts-ignore
    options.vibrate = [200, 100, 200];
    // Same tag must alert again when another chat or message arrives
    // @ts-ignore
    options.renotify = true;
  }

  return { title, options };
}

async function publishInbox(shouldAlert: boolean) {
  const notifications = await self.registration.getNotifications();
  notifications.forEach((notification) => {
    if (notification.tag !== APP_NOTIFICATION_TAG) {
      notification.close();
    }
  });

  if (!inboxByChatKey.size) {
    notifications.forEach((notification) => notification.close());
    return undefined;
  }

  const { title, options } = buildGroupedNotification(shouldAlert);
  return self.registration.showNotification(title, options);
}

function showNotification(notification: NotificationData) {
  rememberInboxEntry(notification);
  const shouldAlert = !notification.reaction && !notification.isSilent;

  return Promise.all([
    // TODO Update condition when reaction badges are implemented
    shouldAlert
      ? playNotificationSound(String(notification.messageId) || notification.chatId || '')
      : undefined,
    publishInbox(shouldAlert),
  ]);
}

async function closeNotifications({
  chatId,
  lastReadInboxMessageId,
}: CloseNotificationData) {
  const entry = inboxByChatKey.get(getInboxKey(chatId));
  const lastMessageId = lastReadInboxMessageId || Number.MAX_VALUE;
  if (!entry || entry.messageId === undefined || entry.messageId <= lastMessageId) {
    inboxByChatKey.delete(getInboxKey(chatId));
  }

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

  if (
    notification.chatId
    && (isChatHidden(notification.chatId) || isInternalChat(notification.chatId))
    && !includesAdsTelegramOrg(notification.body)
  ) return;

  // Don't show already triggered notification
  if (shownNotifications.has(notification.messageId)) {
    shownNotifications.delete(notification.messageId);
    return;
  }

  e.waitUntil(showNotification(notification));
}

async function focusChatMessage(client: WindowClient, data: FocusMessageData) {
  if (!data.chatId) return;
  client.postMessage({
    type: 'focusMessage',
    payload: data,
  });
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
      // Mark this notification as shown if it was handled locally
      shownNotifications.add(notification.messageId);
      return showNotification(notification);
    })());
  }

  if (e.data.type === 'closeMessageNotifications') {
    e.waitUntil(closeNotifications(e.data.payload));
  }
}
