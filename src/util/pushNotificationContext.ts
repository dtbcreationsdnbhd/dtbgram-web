import { IdbStore } from './browser/idb';

const CONTROL_PUSH_TYPES = [
  'READ_HISTORY', 'READ_REACTION', 'MESSAGE_DELETED', 'READ_STORIES', 'STORY_DELETED',
  'MESSAGE_MUTED', 'GEO_LIVE_PENDING', 'SESSION_REVOKE',
] as const;
const MESSAGE_PUSH_TYPES = [
  'PHOTO', 'VIDEO', 'DOC', 'AUDIO', 'ROUND', 'GIF', 'STICKER', 'MUSIC', 'CONTACT',
  'GEO', 'GEOLIVE', 'POLL', 'QUIZ', 'GAME', 'STORY', 'TODO', 'MESSAGES',
  'PHOTOS', 'VIDEOS', 'DOCS', 'PLAYLIST', 'FWDS',
] as const;

type PushControlType = typeof CONTROL_PUSH_TYPES[number];
type PushMessageType = typeof MESSAGE_PUSH_TYPES[number];

export type PushUnreadSnapshot = {
  count: number;
  lastMessageId: number;
  lastReadInboxMessageId: number;
};

export type PushNotificationContext = {
  userId?: string;
  isScreenLocked: boolean;
  hasPasscode: boolean;
  hasWebNotifications: boolean;
  messageText: string;
  photoText?: string;
  videoText?: string;
  fileText?: string;
  messageTexts?: Partial<Record<PushMessageType, string>>;
  controlMessages?: Record<PushControlType, string>;
  deletedMessageText?: string;
  incomingCallText: string;
  shouldShowPreviewsByChatId: Record<string, boolean>;
  unreadByChatId?: Record<string, PushUnreadSnapshot>;
};

const PUSH_NOTIFICATION_CONTEXT_STORE = new IdbStore('tt-push-notification-context');
const CONTEXT_KEY = 'context';
const CONTEXT_STORAGE_TIMEOUT_MS = 2000;

export function checkIfControlPush(type: string): type is PushControlType {
  return CONTROL_PUSH_TYPES.some((controlType) => controlType === type);
}

export function checkIfMessagePushType(type: string): type is PushMessageType {
  return MESSAGE_PUSH_TYPES.some((messageType) => messageType === type);
}

export async function getPushNotificationContext(): Promise<PushNotificationContext | undefined> {
  const context = await runContextStoreTask(() => PUSH_NOTIFICATION_CONTEXT_STORE.get<unknown>(CONTEXT_KEY), undefined);
  return isPushNotificationContext(context) ? context : undefined;
}

export function savePushNotificationContext(context: PushNotificationContext) {
  return runContextStoreTask(async () => {
    await PUSH_NOTIFICATION_CONTEXT_STORE.set(CONTEXT_KEY, context);
    return true;
  }, false);
}

async function runContextStoreTask<T>(task: () => Promise<T>, fallback: T) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), CONTEXT_STORAGE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

function isPushNotificationContext(value: unknown): value is PushNotificationContext {
  if (!value || typeof value !== 'object') return false;
  const context = value as PushNotificationContext;
  const previews = context.shouldShowPreviewsByChatId;
  const messageTexts = context.messageTexts;
  const controlMessages = context.controlMessages;
  return (context.userId === undefined || typeof context.userId === 'string')
    && typeof context.isScreenLocked === 'boolean'
    && typeof context.hasPasscode === 'boolean'
    && typeof context.hasWebNotifications === 'boolean'
    && typeof context.messageText === 'string'
    && (context.photoText === undefined || typeof context.photoText === 'string')
    && (context.videoText === undefined || typeof context.videoText === 'string')
    && (context.fileText === undefined || typeof context.fileText === 'string')
    && (messageTexts === undefined || (Boolean(messageTexts) && typeof messageTexts === 'object'
      && !Array.isArray(messageTexts)
      && Object.values(messageTexts).every((text) => typeof text === 'string')))
    && (controlMessages === undefined || (Boolean(controlMessages) && typeof controlMessages === 'object'
      && !Array.isArray(controlMessages)
      && CONTROL_PUSH_TYPES.every((type) => typeof controlMessages[type] === 'string')))
    && (context.deletedMessageText === undefined || typeof context.deletedMessageText === 'string')
    && typeof context.incomingCallText === 'string'
    && Boolean(previews)
    && typeof previews === 'object'
    && !Array.isArray(previews)
    && Object.values(previews).every((shouldShowPreviews) => typeof shouldShowPreviews === 'boolean');
}
