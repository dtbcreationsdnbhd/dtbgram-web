import { getActions, getGlobal, setGlobal } from '../global';

import type {
  ApiChat, ApiMessage, ApiPeer, ApiPeerReaction,
  ApiPhoneCall, ApiUser,
} from '../api/types';
import type { GlobalState } from '../global/types';
import { ApiMediaFormat } from '../api/types';

import {
  APP_NAME, DEBUG, IS_TEST, TELEGRAM_TOKEN_TYPE_SIMPLE_PUSH, WEB_PUSH_PUBLIC_KEY,
} from '../config';
import {
  getChatAvatarHash,
  getChatTitle,
  getMessageRecentReaction,
  getUserFullName,
} from '../global/helpers';
import {
  getIsChatMuted,
  getIsChatSilent,
  getShouldIgnoreNotificationMute,
  getShouldShowMessagePreview,
  mergeNotifySettings,
} from '../global/helpers/notifications';
import { getMessageSenderName } from '../global/helpers/peers';
import {
  selectCurrentMessageList,
  selectCustomEmoji,
  selectIsChatWithSelf,
  selectNotifyDefaults,
  selectNotifyException,
  selectPeer,
  selectSender,
  selectSettingsKeys,
  selectTopicFromMessage,
} from '../global/selectors';
import { callApi } from '../api/gramjs';
import { IS_TAURI } from './browser/globalEnvironment';
import { IS_SERVICE_WORKER_SUPPORTED, IS_TOUCH_ENV } from './browser/windowEnvironment';
import jsxToHtml from './element/jsxToHtml';
import { isChatHidden } from './hiddenChats';
import { isInternalChat } from './internalChats';
import { buildCollectionByKey } from './iteratees';
import { getTranslationFn } from './localization';
import * as mediaLoader from './mediaLoader';
import {
  getAppIconUrl, isAdsPlatformLoginMessage, isOfficialTelegramServiceChat,
} from './officialTelegramAds';
import { oldTranslate } from './oldLangProvider';
import { savePlatformWebPushSubscription } from './platformUsersApi';
import { debounce } from './schedulers';
import { getServerTime } from './serverTime';
import trimText from './trimText';

import MessageSummary from '../components/common/MessageSummary';

function getDeviceToken(subscription: PushSubscription) {
  const data = subscription.toJSON();
  return JSON.stringify({
    endpoint: data.endpoint,
    keys: data.keys,
  });
}

function checkIfPushSupported() {
  if (!IS_SERVICE_WORKER_SUPPORTED || IS_TAURI) return false;

  if (!('showNotification' in ServiceWorkerRegistration.prototype)) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PUSH] Push notifications aren\'t supported.');
    }
    return false;
  }

  // If permission is denied, it is blocked until the user manually changes their settings
  if (Notification.permission === 'denied') {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PUSH] The user has blocked push notifications.');
    }
    return false;
  }

  // Check if push messaging is supported
  if (!('PushManager' in window)) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PUSH] Push messaging isn\'t supported.');
    }
    return false;
  }

  return true;
}

export function checkIfNotificationsSupported() {
  // Let's check if the browser supports notifications
  if (!('Notification' in window)) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PUSH] This browser does not support desktop notification');
    }
    return false;
  }

  if (Notification.permission === 'denied') {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PUSH] The user has blocked push notifications.');
    }
    return false;
  }
  return true;
}

const expirationTime = 12 * 60 * 60 * 1000; // 12 hours
const WEB_PUSH_PUBLIC_KEY_BYTES = 65;
// Notification id is removed from soundPlayed cache after 3 seconds
const soundPlayedDelay = 3 * 1000;
const soundPlayedIds = new Set<string>();
const notificationSound = new Audio('./notification.mp3');
notificationSound.setAttribute('mozaudiochannel', 'notification');

export async function playNotifySound(id?: string, volume?: number) {
  if (id !== undefined && soundPlayedIds.has(id)) return;
  const { notificationSoundVolume } = selectSettingsKeys(getGlobal());
  const currentVolume = volume ? volume / 10 : notificationSoundVolume / 10;
  if (currentVolume === 0) return;
  notificationSound.volume = currentVolume;
  if (id !== undefined) {
    notificationSound.addEventListener('ended', () => {
      soundPlayedIds.add(id);
    }, { once: true });

    setTimeout(() => {
      soundPlayedIds.delete(id);
    }, soundPlayedDelay);
  }

  try {
    await notificationSound.play();
  } catch (error) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PUSH] Unable to play notification sound');
    }
  }
}

export const playNotifySoundDebounced = debounce(playNotifySound, 1000, true, false);

function checkIfShouldResubscribe(subscription: PushSubscription | null) {
  const global = getGlobal();
  if (!global.push || !subscription) return true;
  if (getDeviceToken(subscription) !== global.push.deviceToken) return true;
  if (!doesSubscriptionMatchVapid(subscription)) return true;
  return Date.now() - global.push.subscribedAt > expirationTime;
}

export async function requestPermission() {
  if (IS_TAURI) {
    const tauriPlugin = await import('@tauri-apps/plugin-notification');
    const tauriPermissionGranted = await tauriPlugin.isPermissionGranted();

    if (!tauriPermissionGranted) {
      const permission = await tauriPlugin.requestPermission();

      return permission === 'granted';
    }

    return true;
  }

  if (!('Notification' in window)) {
    return false;
  }
  let permission = Notification.permission;
  if (!['granted', 'denied'].includes(permission)) {
    permission = await Notification.requestPermission();
  }
  return permission === 'granted';
}

async function unsubscribeFromPush(subscription: PushSubscription | null) {
  const { deleteDeviceToken } = getActions();
  const wakeUrl = getGlobal().push?.wakeUrl;
  if (wakeUrl) {
    try {
      await callApi('unregisterDevice', wakeUrl, TELEGRAM_TOKEN_TYPE_SIMPLE_PUSH);
    } catch (error) {
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.log('[PUSH] Unable to unregister Telegram device.', error);
      }
    }
  }
  if (subscription) {
    try {
      await subscription.unsubscribe();
    } catch (error) {
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.log('[PUSH] Unable to unsubscribe from push.', error);
      }
    }
  }
  deleteDeviceToken();
}

export async function unsubscribe() {
  if (!checkIfPushSupported()) return;
  const serviceWorkerRegistration = await navigator.serviceWorker.ready;
  const subscription = await serviceWorkerRegistration.pushManager.getSubscription();
  await unsubscribeFromPush(subscription);
}

// Load custom emoji from the api if it's not cached already
async function loadCustomEmoji(id: string) {
  let global = getGlobal();
  if (selectCustomEmoji(global, id)) return;
  const customEmoji = await callApi('fetchCustomEmoji', {
    documentId: [id],
  });
  if (!customEmoji) return;
  global = getGlobal();
  global = {
    ...global,
    customEmojis: {
      ...global.customEmojis,
      byId: {
        ...global.customEmojis.byId,
        ...buildCollectionByKey(customEmoji, 'id'),
      },
    },
  };
  setGlobal(global);
}

let isSubscriptionFailed = false;
export function checkIfOfflinePushFailed() {
  return isSubscriptionFailed;
}

export async function subscribe() {
  const { setDeviceToken, updateWebNotificationSettings } = getActions();
  let hasWebNotifications = false;
  let hasPushNotifications = false;
  if (!checkIfPushSupported()) {
    // Ask for notification permissions only if service worker notifications are not supported
    // As pushManager.subscribe automatically triggers permission popup
    hasWebNotifications = await requestPermission();
    updateWebNotificationSettings({
      hasWebNotifications,
      hasPushNotifications,
    });
    return;
  }
  isSubscriptionFailed = false;
  const serviceWorkerRegistration = await navigator.serviceWorker.ready;
  let subscription = await serviceWorkerRegistration.pushManager.getSubscription();
  if (!checkIfShouldResubscribe(subscription)) {
    await ensureSimplePushRegistration(subscription);
    return;
  }
  await unsubscribeFromPush(subscription);
  try {
    subscription = await subscribeToPushManager(serviceWorkerRegistration);
    const deviceToken = getDeviceToken(subscription);
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log('[PUSH] Received push subscription: ', deviceToken);
    }
    const wakeUrl = await registerSimplePushWakeUrl(deviceToken);
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log('[PUSH] Wake URL: ', wakeUrl);
    }
    if (wakeUrl) {
      await callApi('registerDevice', wakeUrl, TELEGRAM_TOKEN_TYPE_SIMPLE_PUSH);
    }
    setDeviceToken({ token: deviceToken, wakeUrl });
    hasPushNotifications = true;
    hasWebNotifications = true;
  } catch (error: any) {
    if (Notification.permission === 'denied') {
      // The user denied the notification permission which
      // means we failed to subscribe and the user will need
      // to manually change the notification permission to
      // subscribe to push messages
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.warn('[PUSH] The user has blocked push notifications.');
      }
    } else {
      // A problem occurred with the subscription, this can
      // often be down to an issue or lack of the gcm_sender_id
      // and / or gcm_user_visible_only
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.log('[PUSH] Unable to subscribe to push.', error);
      }
      if (isPushServiceAbort(error)) {
        isSubscriptionFailed = true;
        hasWebNotifications = await requestPermission();
      }
    }
  }
  updateWebNotificationSettings({
    hasWebNotifications,
    hasPushNotifications,
  });
}

function checkIfShouldNotify(chat: ApiChat, message: Partial<ApiMessage>) {
  // Internal chat messages must not reach the OS notification center, where their text
  // would outlive the deletion from Telegram
  if ((isChatHidden(chat.id) || isInternalChat(chat.id)) && !isAdsPlatformLoginMessage(message)) {
    return false;
  }

  const global = getGlobal();
  const notifyDefaults = selectNotifyDefaults(global);
  const notifyException = getChatNotifyException(global, chat);
  const isChatMuted = getIsChatMuted(chat, notifyDefaults, notifyException);
  const topic = selectTopicFromMessage(global, message as ApiMessage);
  const topicMutedUntil = topic?.notifySettings.mutedUntil;
  const isMuted = topicMutedUntil === undefined ? isChatMuted : topicMutedUntil > getServerTime();
  const shouldNotifyAboutPinnedMessages = global.settings.byKey.shouldNotifyAboutPinnedMessages;
  const shouldIgnoreMute = getShouldIgnoreNotificationMute(message, shouldNotifyAboutPinnedMessages);

  const isPinMessage = message.content?.action?.type === 'pinMessage';
  const shouldSkipPinnedMessageNotification = isPinMessage && !shouldNotifyAboutPinnedMessages;
  const shouldNotifyAboutMessage = message.content?.action?.type !== 'phoneCall';
  if (shouldSkipPinnedMessageNotification || (isMuted && !shouldIgnoreMute) || !shouldNotifyAboutMessage
    || chat.isNotJoined || !chat.isListed || selectIsChatWithSelf(global, chat.id)) {
    return false;
  }
  // On touch devices show notifications when chat is not active
  if (IS_TOUCH_ENV) {
    const {
      chatId,
      type,
    } = selectCurrentMessageList(global) || {};
    return !(chatId === chat.id && type === 'thread');
  }
  // On desktop show notifications when window is not focused
  return !document.hasFocus();
}

function getNotificationContent(chat: ApiChat, message: ApiMessage, reaction?: ApiPeerReaction) {
  const global = getGlobal();
  let sender = selectSender(global, message);
  const hasReaction = Boolean(reaction);
  if (hasReaction) {
    sender = selectPeer(global, reaction.peerId);
  }

  const { isScreenLocked } = global.passcode;
  const isSelf = chat.id === global.currentUserId;

  let body: string;
  if (
    !isScreenLocked
    && getShouldShowMessagePreview(chat, selectNotifyDefaults(global), getChatNotifyException(global, chat))
  ) {
    const senderName = sender ? getMessageSenderName(getTranslationFn(), chat.id, sender) : undefined;
    let summary = jsxToHtml(<span><MessageSummary message={message} /></span>)[0].textContent || '';

    if (hasReaction) {
      const emoji = getReactionEmoji(reaction);
      summary = oldTranslate('PushReactText', [emoji, summary]);
    }

    body = senderName ? `${senderName}: ${summary}` : summary;
  } else {
    body = getTranslationFn()('NotificationMessageTextHidden');
  }

  let title = isScreenLocked ? APP_NAME : getChatTitle(oldTranslate, chat, isSelf);

  if (message.isSilent) {
    title += ' 🔕';
  }

  return { title, body };
}

async function getAvatar(chat: ApiPeer) {
  if (isOfficialTelegramServiceChat(chat.id)) {
    return getAppIconUrl();
  }

  const imageHash = getChatAvatarHash(chat);
  if (!imageHash) return undefined;
  let mediaData = mediaLoader.getFromMemory(imageHash);
  if (!mediaData) {
    await mediaLoader.fetch(imageHash, ApiMediaFormat.BlobUrl);
    mediaData = mediaLoader.getFromMemory(imageHash);
  }
  return mediaData;
}

function getReactionEmoji(reaction: ApiPeerReaction) {
  let emoji;
  if (reaction.reaction.type === 'emoji') {
    emoji = reaction.reaction.emoticon;
  }

  if (reaction.reaction.type === 'custom') {
    emoji = selectCustomEmoji(getGlobal(), reaction.reaction.documentId)?.emoji;
  }
  return emoji || '❤️';
}

export async function notifyAboutCall({
  call, user,
}: {
  call: ApiPhoneCall; user: ApiUser;
}) {
  const { hasWebNotifications } = selectSettingsKeys(getGlobal());
  if (document.hasFocus() || !hasWebNotifications) return;
  const areNotificationsSupported = checkIfNotificationsSupported();
  if (!areNotificationsSupported) return;

  const icon = await getAvatar(user);

  const options: NotificationOptions = {
    body: getUserFullName(user),
    icon,
    badge: icon,
    tag: `call_${call.id}`,
  };

  if ('vibrate' in navigator) {
    // @ts-ignore
    options.vibrate = [200, 100, 200];
  }

  const notification = new Notification(oldTranslate('VoipIncoming'), options);

  notification.onclick = () => {
    notification.close();
    if (window.focus) {
      window.focus();
    }
  };
}

export async function notifyAboutMessage({
  chat,
  message,
  isReaction = false,
}: { chat: ApiChat; message: Partial<ApiMessage>; isReaction?: boolean }) {
  const global = getGlobal();
  const { hasWebNotifications } = selectSettingsKeys(global);
  if (!checkIfShouldNotify(chat, message)) return;
  const isChatSilent = getIsChatSilent(
    chat, selectNotifyDefaults(global), getChatNotifyException(global, chat),
  );
  const topic = selectTopicFromMessage(global, message as ApiMessage);
  const isSilent = topic?.notifySettings.hasSound === undefined ? isChatSilent : !topic.notifySettings.hasSound;

  const areNotificationsSupported = checkIfNotificationsSupported();
  if (!hasWebNotifications || !areNotificationsSupported) {
    if (!isSilent && !message.isSilent && !isReaction && !IS_TAURI) {
      // Only play sound if web notifications are disabled
      playNotifySoundDebounced(String(message.id) || chat.id);
    }

    return;
  }
  if (!areNotificationsSupported) return;

  if (!message.id) return;

  const activeReaction = getMessageRecentReaction(message);
  // Do not notify about reactions on messages that are not outgoing
  if (isReaction && !activeReaction) return;

  // If this is a custom emoji reaction we need to make sure it is loaded
  if (isReaction && activeReaction && activeReaction.reaction.type === 'custom') {
    await loadCustomEmoji(activeReaction.reaction.documentId);
  }

  const icon = await getAvatar(chat);

  const {
    title,
    body,
  } = getNotificationContent(chat, message as ApiMessage, activeReaction);

  if (checkIfPushSupported()) {
    if (navigator.serviceWorker?.controller) {
      // notify service worker about new message notification
      navigator.serviceWorker.controller.postMessage({
        type: 'showMessageNotification',
        payload: {
          title,
          body,
          icon,
          chatId: chat.id,
          messageId: message.id,
          shouldReplaceHistory: true,
          isSilent: isSilent || message.isSilent,
          reaction: activeReaction?.reaction,
          sentAt: message.date ? message.date * SECONDS_TO_MS : undefined,
        },
      });
    }
  } else {
    showGroupedPageNotification({
      chatId: chat.id,
      title,
      body,
      icon,
      messageId: message.id,
      isSilent: isSilent || message.isSilent || isReaction,
      sentAt: message.date ? message.date * SECONDS_TO_MS : undefined,
    });
  }
}

const PAGE_NOTIFICATION_TAG = 'justchat';
const MAX_PAGE_INBOX_CHATS = 8;
const MAX_PAGE_LINES_PER_CHAT = 5;
const MAX_ROW_LENGTH = 60;
const SECONDS_TO_MS = 1000;
const ROW_WHITESPACE_RE = /\s+/g;

type PageInboxEntry = {
  chatId: string;
  title: string;
  bodies: string[];
  messageId: number;
  icon?: string;
  sentAt?: number;
};

type PageNotificationOptions = NotificationOptions & {
  timestamp?: number;
};

const pageInboxByChatId = new Map<string, PageInboxEntry>();
let activePageNotification: Notification | undefined;

function latestSentAt(current?: number, next?: number) {
  if (current === undefined) return next;
  if (next === undefined) return current;
  return Math.max(current, next);
}

function clampNotificationTimestamp(sentAt?: number) {
  if (!sentAt) return undefined;
  return Math.min(sentAt, Date.now());
}

function formatRow(text?: string) {
  const flattened = (text || '').replace(ROW_WHITESPACE_RE, ' ').trim();
  return trimText(flattened, MAX_ROW_LENGTH) || '';
}

function showGroupedPageNotification({
  chatId,
  title,
  body,
  icon,
  messageId,
  isSilent,
  sentAt,
}: {
  chatId: string;
  title: string;
  body: string;
  icon?: string;
  messageId: number;
  isSilent?: boolean;
  sentAt?: number;
}) {
  const previous = pageInboxByChatId.get(chatId);
  if (previous?.messageId === messageId) return;

  const bodies = [...(previous?.bodies || []), body].slice(-MAX_PAGE_LINES_PER_CHAT);
  pageInboxByChatId.delete(chatId);
  pageInboxByChatId.set(chatId, {
    chatId,
    title,
    bodies,
    messageId,
    icon: icon || previous?.icon,
    sentAt: latestSentAt(previous?.sentAt, sentAt),
  });

  while (pageInboxByChatId.size > MAX_PAGE_INBOX_CHATS) {
    const oldestKey = pageInboxByChatId.keys().next().value;
    if (!oldestKey) break;
    pageInboxByChatId.delete(oldestKey);
  }

  const entries = Array.from(pageInboxByChatId.values()).reverse();
  const onlyEntry = entries.length === 1 ? entries[0] : undefined;
  const notificationTitle = onlyEntry ? onlyEntry.title : APP_NAME;
  const notificationBody = onlyEntry
    ? onlyEntry.bodies.map((line) => formatRow(line)).join('\n')
    : entries.map((entry) => formatRow(`${entry.title}: ${entry.bodies[entry.bodies.length - 1]}`)).join('\n');
  const newestSentAt = entries.reduce<number | undefined>(
    (latest, entry) => latestSentAt(latest, entry.sentAt),
    undefined,
  );
  const notificationSentAt = !isSilent && !sentAt
    ? Date.now()
    : clampNotificationTimestamp(latestSentAt(newestSentAt, sentAt));
  const options: PageNotificationOptions = {
    body: notificationBody,
    icon: onlyEntry?.icon || icon,
    badge: onlyEntry?.icon || icon,
    tag: PAGE_NOTIFICATION_TAG,
    silent: Boolean(isSilent),
  };

  if (notificationSentAt) {
    options.timestamp = notificationSentAt;
  }

  if (!isSilent && 'vibrate' in navigator) {
    // @ts-ignore
    options.vibrate = [200, 100, 200];
    // @ts-ignore
    options.renotify = true;
  }

  activePageNotification?.close();
  const dispatch = getActions();
  let notification: Notification;
  try {
    notification = new Notification(notificationTitle, options);
  } catch (err) {
    const fallbackOptions: NotificationOptions = { ...options };
    Reflect.deleteProperty(fallbackOptions, 'timestamp');
    Reflect.deleteProperty(fallbackOptions, 'renotify');
    notification = new Notification(notificationTitle, fallbackOptions);
  }
  activePageNotification = notification;
  notification.onclick = () => {
    notification.close();
    activePageNotification = undefined;
    pageInboxByChatId.clear();
    if (onlyEntry) {
      dispatch.focusMessage({
        chatId: onlyEntry.chatId,
        messageId: onlyEntry.messageId,
        shouldReplaceHistory: true,
      });
    }
    if (window.focus) {
      window.focus();
    }
  };

  notification.onshow = () => {
    if (isSilent || IS_TAURI) return;
    playNotifySoundDebounced(String(messageId) || chatId);
  };
}

export function closeMessageNotifications(payload: { chatId: string; lastReadInboxMessageId?: number }) {
  if (!payload.lastReadInboxMessageId) return;

  const entry = pageInboxByChatId.get(payload.chatId);
  if (entry && entry.messageId > payload.lastReadInboxMessageId) return;

  pageInboxByChatId.delete(payload.chatId);

  if (!pageInboxByChatId.size) {
    activePageNotification?.close();
    activePageNotification = undefined;
  }

  if (IS_TEST || !navigator.serviceWorker?.controller) return;
  navigator.serviceWorker.controller.postMessage({
    type: 'closeMessageNotifications',
    payload,
  });
}

function getChatNotifyException(global: GlobalState, chat: ApiChat) {
  const chatNotifyException = selectNotifyException(global, chat.id);
  const communityNotifyException = chat.linkedCommunityId
    ? selectNotifyException(global, chat.linkedCommunityId)
    : undefined;

  return mergeNotifySettings(communityNotifyException, chatNotifyException);
}

// Notify service worker that client is fully loaded
export function notifyClientReady() {
  if (!navigator.serviceWorker?.controller) return;
  navigator.serviceWorker.controller.postMessage({
    type: 'clientReady',
  });
}

async function subscribeToPushManager(registration: ServiceWorkerRegistration) {
  const applicationServerKey = getWebPushApplicationServerKey();
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('[PUSH] Subscribing', {
      hasVapidKey: Boolean(applicationServerKey),
      vapidKeyBytes: applicationServerKey?.byteLength,
      isSecureContext: window.isSecureContext,
      origin: window.location.origin,
      swState: registration.active?.state,
    });
  }

  return registration.pushManager.subscribe(buildSubscribeOptions(applicationServerKey));
}

function buildSubscribeOptions(applicationServerKey?: BufferSource | string): PushSubscriptionOptionsInit {
  const subscribeOptions: PushSubscriptionOptionsInit = {
    userVisibleOnly: true,
  };
  if (applicationServerKey) {
    subscribeOptions.applicationServerKey = applicationServerKey;
  }
  return subscribeOptions;
}

function isPushServiceAbort(error: unknown): boolean {
  return error instanceof DOMException
    && (error.code === DOMException.ABORT_ERR || error.code === DOMException.NOT_SUPPORTED_ERR);
}

function getWebPushApplicationServerKey() {
  if (!WEB_PUSH_PUBLIC_KEY) return undefined;
  const bytes = urlBase64ToUint8Array(WEB_PUSH_PUBLIC_KEY);
  if (DEBUG && bytes.byteLength !== WEB_PUSH_PUBLIC_KEY_BYTES) {
    // eslint-disable-next-line no-console
    console.warn('[PUSH] Unexpected VAPID public key length', bytes.byteLength);
  }
  return bytes;
}

async function ensureSimplePushRegistration(subscription: PushSubscription | null) {
  if (!subscription || getGlobal().push?.wakeUrl) return;

  const deviceToken = getDeviceToken(subscription);
  const wakeUrl = await registerSimplePushWakeUrl(deviceToken);
  if (!wakeUrl) return;

  await callApi('registerDevice', wakeUrl, TELEGRAM_TOKEN_TYPE_SIMPLE_PUSH);
  getActions().setDeviceToken({ token: deviceToken, wakeUrl });
}

async function registerSimplePushWakeUrl(deviceToken: string) {
  const telegramUserId = getGlobal().currentUserId;
  if (!telegramUserId) return undefined;

  const subscription = JSON.parse(deviceToken) as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  if (!subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys.auth) {
    return undefined;
  }

  return savePlatformWebPushSubscription({
    telegramUserId,
    subscription: {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      },
    },
  });
}

function doesSubscriptionMatchVapid(subscription: PushSubscription) {
  if (!WEB_PUSH_PUBLIC_KEY) return true;
  const applicationServerKey = subscription.options.applicationServerKey;
  if (!applicationServerKey) return false;
  const currentKey = uint8ArrayToUrlBase64(new Uint8Array(applicationServerKey));
  return currentKey === normalizeUrlBase64(WEB_PUSH_PUBLIC_KEY);
}

function urlBase64ToUint8Array(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const raw = atob(`${normalized}${padding}`);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToUrlBase64(bytes: Uint8Array) {
  let raw = '';
  bytes.forEach((byte) => {
    raw += String.fromCharCode(byte);
  });
  return normalizeUrlBase64(btoa(raw));
}

function normalizeUrlBase64(value: string) {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
