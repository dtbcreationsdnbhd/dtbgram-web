import type { NativeNotification, ProbeConfig, PushDecision } from './types.ts';
import type { UnreadUpdate } from './unread.ts';

import { hashValue, isRecord } from './config.ts';

const MESSAGE_TYPE_RE = /^(CHAT_|CHANNEL_)?(?:MESSAGE_([A-Z_]+)|(MESSAGES))$/;
const LOC_KEY_RE = /^[A-Z_0-9]{1,64}$/;
const CHANNEL_ID_BASE = 1000000000000n;
const MAX_TITLE_CHARACTERS = 80;
const MAX_BODY_CHARACTERS = 400;
const MAX_ARGUMENTS = 16;
const MAX_STRING_LENGTH = 4096;
const CAPTION_MEDIA_TYPES = new Set(['PHOTO', 'VIDEO', 'DOC']);
const ALBUM_MEDIA_TYPES = new Set(['MESSAGES', 'PHOTOS', 'VIDEOS', 'DOCS', 'PLAYLIST', 'FWDS']);
const MAX_CONTROL_MESSAGE_IDS = 128;

export function formatPush(payload: unknown, config: ProbeConfig): PushDecision {
  if (!isRecord(payload)) return { outcome: 'invalidPayload' };
  const source = isRecord(payload.data) ? payload.data : payload;
  const locKey = typeof source.loc_key === 'string' && LOC_KEY_RE.test(source.loc_key)
    ? source.loc_key : undefined;
  if (!locKey) return { outcome: 'missingType' };
  const rejected = { locKey };
  if (parseId(source.user_id) !== config.userId) return { ...rejected, outcome: 'ownerMismatch' };
  if (checkIfTrue(source.mute)) return { ...rejected, outcome: 'muted' };
  if (!config.context.hasWebNotifications) return { ...rejected, outcome: 'notificationsDisabled' };
  const match = locKey.match(MESSAGE_TYPE_RE);
  if (!match) return { ...rejected, outcome: 'controlOrUnsupportedType' };
  const messageType = match[2] || match[3];
  const context = config.context;
  const labels = context.messageTexts;
  const label: unknown = labels && Object.hasOwn(labels, messageType)
    ? Reflect.get(labels, messageType) : undefined;
  if (messageType !== 'TEXT' && typeof label !== 'string'
    && !CAPTION_MEDIA_TYPES.has(messageType)) return { ...rejected, outcome: 'unsupportedMediaType' };
  const custom = parseObject(source.custom);
  const args = parseArguments(source.loc_args);
  if (!custom || !args) return { ...rejected, outcome: 'invalidMessageFields' };
  const chatId = parseChatId(custom);
  const messageId = parseId(custom.msg_id);
  if (!chatId || !messageId) return { ...rejected, outcome: 'missingMessageIdentity' };
  if (config.excludedChatIds.includes(chatId)) return { ...rejected, outcome: 'excludedChat' };
  const hasPreview = !context.hasPasscode && !context.isScreenLocked
    && context.shouldShowPreviewsByChatId[chatId] === true;
  const isGroup = match[1] === 'CHAT_';
  const titleIndex = isGroup ? 1 : 0;
  const textIndex = isGroup ? 2 : 1;
  const title = args[titleIndex];
  const suppliedText = parseText(source.caption) || parseText(source.description) || parseText(source.message)
    || ((messageType === 'TEXT' || CAPTION_MEDIA_TYPES.has(messageType)) ? args[textIndex] : undefined);
  if (hasPreview && (!title || (messageType === 'TEXT' && !suppliedText))) {
    return { ...rejected, outcome: 'missingPreviewFields' };
  }
  const mediaLabel = typeof label === 'string' ? label
    : messageType === 'PHOTO' ? context.photoText
      : messageType === 'VIDEO' ? context.videoText : context.fileText;
  const body = messageType === 'TEXT' ? suppliedText
    : [mediaLabel || context.messageText, suppliedText].filter(Boolean).join(' ');
  const previewBody = [isGroup ? args[0] : undefined, body || context.messageText].filter(Boolean).join(': ');
  const url = new URL(config.baseUrl);
  url.hash = chatId;
  const namespace = custom.channel_id !== undefined ? `channel:${chatId}` : 'common';
  const messageIdentity = `${config.userId}:${namespace}:${messageId}`;
  const identity = hashValue(`${messageIdentity}:${locKey}:${parseId(custom.edit_date) || '0'}:${body || ''}`);
  return {
    outcome: hasPreview ? 'previewReady' : 'privateNotificationReady',
    locKey,
    identity,
    notification: {
      title: truncateText(hasPreview ? title : config.appName, MAX_TITLE_CHARACTERS),
      body: truncateText(hasPreview ? previewBody : context.messageText, MAX_BODY_CHARACTERS),
      url: url.href,
      tag: `native-chat-${hashValue(`${config.userId}:${chatId}`)}`,
      isSilent: checkIfTrue(custom.silent),
    },
  };
}

export function formatUnreadCount(notification: NativeNotification, count: number): NativeNotification {
  const suffix = ` (${count})`;
  return {
    ...notification,
    title: `${truncateText(notification.title, MAX_TITLE_CHARACTERS - suffix.length)}${suffix}`,
    unreadCount: count,
  };
}

export function parsePushUnreadUpdate(payload: unknown, userId: string): UnreadUpdate | undefined {
  if (!isRecord(payload)) return undefined;
  const source = isRecord(payload.data) ? payload.data : payload;
  if (parseId(source.user_id) !== userId || typeof source.loc_key !== 'string') return undefined;
  const custom = parseObject(source.custom);
  if (!custom) return undefined;
  const chatId = parseChatId(custom);
  if (source.loc_key === 'MESSAGE_DELETED') {
    const values = typeof custom.messages === 'string' ? custom.messages.split(',') : undefined;
    if (!values?.length || values.length > MAX_CONTROL_MESSAGE_IDS) return undefined;
    const messageIds = values.map((value) => parseSafeMessageId(value.trim()));
    if (messageIds.some((value) => value === undefined)) return undefined;
    return { kind: 'delete', chatId, messageIds: messageIds.filter((value) => value !== undefined) };
  }
  if (!chatId) return undefined;
  if (source.loc_key === 'READ_HISTORY') {
    const maxId = parseSafeMessageId(custom.max_id);
    return maxId === undefined ? undefined : { kind: 'read', chatId, maxId };
  }
  const match = source.loc_key.match(MESSAGE_TYPE_RE);
  const messageId = parseSafeMessageId(custom.msg_id);
  if (!match || messageId === undefined || checkIfTrue(custom.schedule)) return undefined;
  return {
    kind: 'message', chatId, messageId,
    hasUnknownSize: ALBUM_MEDIA_TYPES.has(match[2] || match[3]) || checkIfTrue(source.mute),
  };
}

function parseSafeMessageId(value: unknown) {
  const id = parseId(value);
  if (!id) return undefined;
  const number = Number(id);
  return Number.isSafeInteger(number) ? number : undefined;
}

function parseObject(value: unknown) {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || value.length > MAX_STRING_LENGTH) return undefined;
  try {
    const result: unknown = JSON.parse(value);
    return isRecord(result) ? result : undefined;
  } catch {
    return undefined;
  }
}

function parseArguments(value: unknown): string[] | undefined {
  if (typeof value === 'string' && value.length <= MAX_STRING_LENGTH) {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(value) || value.length > MAX_ARGUMENTS
    || !value.every((argument) => typeof argument === 'string' && argument.length <= MAX_STRING_LENGTH)) {
    return undefined;
  }
  return value;
}

function parseChatId(custom: Record<string, unknown>) {
  if (custom.channel_id !== undefined) {
    const channelId = parseId(custom.channel_id);
    return channelId ? String(-CHANNEL_ID_BASE - BigInt(channelId)) : undefined;
  }
  if (custom.chat_id !== undefined) {
    const chatId = parseId(custom.chat_id);
    return chatId ? `-${chatId}` : undefined;
  }
  return parseId(custom.from_id);
}

function parseId(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : undefined;
}

function parseText(value: unknown) {
  return typeof value === 'string' && value.trim() && value.length <= MAX_STRING_LENGTH ? value : undefined;
}

function checkIfTrue(value: unknown) {
  return value === true || value === 1 || value === '1';
}

function truncateText(value: string, length: number) {
  return Array.from(value).slice(0, length).join('');
}
