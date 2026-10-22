import { createECDH, createHash, createPrivateKey, randomBytes } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';

import type { PushNotificationContext } from '../../src/util/pushNotificationContext.ts';
import type { FirebaseCredentials, ProbeConfig, ProbeSetup, Subscription } from './types.ts';

import { checkIfUnreadSnapshots } from './unread.ts';
import { isRecord } from './validation.ts';

export { isRecord } from './validation.ts';

export const MAX_LIFETIME_MS = 60 * 60 * 1000;
const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_LABEL_LENGTH = 512;
const MAX_NATIVE_TOKEN_LENGTH = 8192;
const PRIVATE_FILE_MODE = 0o600;
const PUBLIC_FILE_BITS = 0o077;
const AUTH_BYTES = 16;
const PRIVATE_KEY_BYTES = 32;
const PUBLIC_KEY_BYTES = 65;
const CAPABILITY_BYTES = 32;
const MAX_CHAT_SETTINGS = 10000;
const MAX_URL_LENGTH = 512;
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export async function prepareProbe(
  setupPath: string, probePath: string, enrollmentPath: string, publicOrigin: string,
) {
  const setup = parseSetup(await readPrivateJson(setupPath));
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== publicOrigin || origin.username || origin.password) {
    throw new Error('Public origin must be an HTTPS origin without a path or trailing slash');
  }
  if (new Set([setupPath, probePath, enrollmentPath]).size !== 3) {
    throw new Error('Setup, probe, and enrollment must use distinct files');
  }
  const receiver = createReceiver(origin.origin);
  const { subscription } = receiver;
  const createdAt = Date.now();
  const probe: ProbeConfig = {
    ...setup,
    version: 1,
    createdAt,
    expiresAt: createdAt + MAX_LIFETIME_MS,
    disabled: false,
    privateKey: receiver.privateKey,
    subscription,
  };
  await writePrivateJson(probePath, probe);
  await writePrivateJson(enrollmentPath, {
    userId: setup.userId,
    nativeTokenHash: hashValue(setup.nativeToken),
    expiresAt: probe.expiresAt,
    subscription,
  });
}

export function createReceiver(origin: string) {
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();
  const subscription: Subscription = {
    endpoint: `${origin}/telegram-push/${randomBytes(CAPABILITY_BYTES).toString('base64url')}`,
    keys: {
      p256dh: receiver.getPublicKey().toString('base64url'),
      auth: randomBytes(AUTH_BYTES).toString('base64url'),
    },
  };
  return { privateKey: receiver.getPrivateKey().toString('base64url'), subscription };
}

export async function readProbe(path: string) {
  const value = await readPrivateJson(path);
  const setup = parseSetup(value);
  if (!isRecord(value) || value.version !== 1 || typeof value.disabled !== 'boolean'
    || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt)) {
    throw new Error('Invalid probe configuration');
  }
  const createdAt = Number(value.createdAt);
  const expiresAt = Number(value.expiresAt);
  const now = Date.now();
  if (createdAt > now || expiresAt <= now || expiresAt <= createdAt || expiresAt - createdAt > MAX_LIFETIME_MS) {
    throw new Error('Probe has expired or exceeds its one-hour lifetime');
  }
  if (typeof value.privateKey !== 'string' || !isRecord(value.subscription)
    || !isRecord(value.subscription.keys)) throw new Error('Invalid receiver configuration');
  const { endpoint, keys } = value.subscription;
  if (typeof endpoint !== 'string' || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
    throw new Error('Invalid receiver subscription');
  }
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !/^\/telegram-push\/[A-Za-z0-9_-]{43}$/.test(url.pathname)) {
    throw new Error('Invalid receiver endpoint');
  }
  const privateKey = decodeBase64Url(value.privateKey, PRIVATE_KEY_BYTES);
  const publicKey = decodeBase64Url(keys.p256dh, PUBLIC_KEY_BYTES);
  decodeBase64Url(keys.auth, AUTH_BYTES);
  const receiver = createECDH('prime256v1');
  receiver.setPrivateKey(privateKey);
  if (!receiver.getPublicKey().equals(publicKey)) throw new Error('Receiver keys do not match');
  return {
    ...setup,
    version: 1,
    createdAt,
    expiresAt,
    disabled: value.disabled,
    privateKey: value.privateKey,
    subscription: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
  } satisfies ProbeConfig;
}

export async function readFirebaseCredentials(path: string): Promise<FirebaseCredentials> {
  const value = await readPrivateJson(path);
  if (!isRecord(value) || value.type !== 'service_account' || typeof value.project_id !== 'string'
    || !/^[a-z][a-z0-9-]{4,62}$/.test(value.project_id) || typeof value.client_email !== 'string'
    || !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(value.client_email)
    || typeof value.private_key !== 'string'
    || (value.token_uri !== undefined && value.token_uri !== GOOGLE_TOKEN_URL)) {
    throw new Error('Invalid Firebase service-account credentials');
  }
  const key = createPrivateKey(value.private_key);
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) {
    throw new Error('Firebase service account must have an RSA key of at least 2048 bits');
  }
  return { projectId: value.project_id, clientEmail: value.client_email, privateKey: value.private_key };
}

export function decodeBase64Url(value: string, length: number) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid receiver key encoding');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== length || decoded.toString('base64url') !== value) {
    throw new Error('Invalid receiver key length');
  }
  return decoded;
}

export function hashValue(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

async function readPrivateJson(path: string): Promise<unknown> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_CONFIG_BYTES || (metadata.mode & PUBLIC_FILE_BITS) !== 0) {
    throw new Error('Configuration must be a private regular file (chmod 600), at most 128 KiB');
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('Cannot read configuration JSON');
  }
}

async function writePrivateJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`, { flag: 'wx', mode: PRIVATE_FILE_MODE });
}

export function parseSetup(value: unknown): ProbeSetup {
  if (!isRecord(value) || typeof value.userId !== 'string' || !/^[1-9]\d{0,19}$/.test(value.userId)
    || typeof value.nativeToken !== 'string' || !value.nativeToken
    || value.nativeToken.length > MAX_NATIVE_TOKEN_LENGTH || /\s/.test(value.nativeToken)
    || !isLabel(value.appName) || typeof value.baseUrl !== 'string' || value.baseUrl.length > MAX_URL_LENGTH
    || !Array.isArray(value.excludedChatIds) || value.excludedChatIds.length > MAX_CHAT_SETTINGS
    || !value.excludedChatIds.every((chatId) => typeof chatId === 'string' && /^-?\d{1,20}$/.test(chatId))
    || !isContext(value.context) || value.context.userId !== value.userId) {
    throw new Error('Invalid native probe setup or account context');
  }
  const url = new URL(value.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw new Error('App URL must be HTTPS without credentials, query, or fragment');
  }
  return {
    userId: value.userId,
    nativeToken: value.nativeToken,
    appName: value.appName,
    baseUrl: url.href,
    excludedChatIds: value.excludedChatIds,
    context: sanitizeContext(value.context),
  };
}

function sanitizeContext(context: PushNotificationContext) {
  const sanitized = { ...context };
  Reflect.deleteProperty(sanitized, 'nativeUnreadCounts');
  return sanitized;
}

function isLabel(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_LABEL_LENGTH;
}

function isContext(value: unknown): value is PushNotificationContext {
  if (!isRecord(value) || typeof value.userId !== 'string'
    || typeof value.isScreenLocked !== 'boolean' || typeof value.hasPasscode !== 'boolean'
    || typeof value.hasWebNotifications !== 'boolean' || !isLabel(value.messageText)
    || !isLabel(value.incomingCallText) || !isRecord(value.shouldShowPreviewsByChatId)) return false;
  const previews = Object.entries(value.shouldShowPreviewsByChatId);
  if (previews.length > MAX_CHAT_SETTINGS
    || previews.some(([key, enabled]) => !/^-?\d{1,20}$/.test(key) || typeof enabled !== 'boolean')) return false;
  if ([value.photoText, value.videoText, value.fileText, value.deletedMessageText]
    .some((label) => label !== undefined && !isLabel(label))) return false;
  if (value.unreadByChatId !== undefined && !checkIfUnreadSnapshots(value.unreadByChatId)) return false;
  return value.messageTexts === undefined || (isRecord(value.messageTexts)
    && Object.values(value.messageTexts).every(isLabel));
}
