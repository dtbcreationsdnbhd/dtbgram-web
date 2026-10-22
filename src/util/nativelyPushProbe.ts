import { getGlobal } from '../global';

import type { PushNotificationContext } from './pushNotificationContext';

import { APP_NAME, IS_BETA, TELEGRAM_TOKEN_TYPE_WEB_PUSH } from '../config';
import { callApi } from '../api/gramjs';
import hiddenChatsConfig from '../hiddenChats.json';
import internalChatsConfig from '../internalChats.json';
import { IdbStore } from './browser/idb';
import download from './download';
import { isChatHidden } from './hiddenChats';
import { isInternalChat } from './internalChats';
import { checkIfNativelyApp, getNativelyPushState } from './natively';
import { refreshPushNotificationContext } from './notifications';
import { getPushNotificationContext } from './pushNotificationContext';

type ProbeEnrollment = {
  userId: string;
  nativeTokenHash: string;
  expiresAt: number;
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
};

type ProbeRegistration = {
  userId: string;
  token: string;
  expiresAt: number;
};

declare global {
  interface Window {
    nativePushProbe?: {
      exportSetup: () => Promise<void>;
      register: (enrollment: unknown) => Promise<boolean>;
      unregister: () => Promise<boolean>;
    };
  }
}

const PROBE_STORE = new IdbStore('tt-native-push-probe');
const SETUP_FILENAME = 'native-push-probe-setup.json';
const MAX_PROBE_LIFETIME_MS = 60 * 60 * 1000;
const OBJECT_URL_LIFETIME_MS = 60000;
let isRegistrationBusy = false;

export function installNativelyPushProbe() {
  if (!IS_BETA || !checkIfNativelyApp()) return;
  window.nativePushProbe = { exportSetup, register: registerProbe, unregister: unregisterProbe };
}

async function exportSetup() {
  const userId = requireProbeAccount();
  const { token } = await requireNativeToken(userId);
  await refreshPushNotificationContext();
  const context = await getPushNotificationContext();
  ensureProbeAccount(userId);
  if (context?.userId !== userId) throw new Error('Native probe privacy context is unavailable');

  const shouldShowPreviewsByChatId = { ...context.shouldShowPreviewsByChatId };
  Object.keys(shouldShowPreviewsByChatId).forEach((chatId) => {
    if (isChatHidden(chatId) || isInternalChat(chatId)) shouldShowPreviewsByChatId[chatId] = false;
  });
  const probeContext: PushNotificationContext = { ...context, shouldShowPreviewsByChatId };
  const baseUrl = new URL(window.location.href);
  baseUrl.hash = '';
  baseUrl.search = '';
  const setup = {
    userId,
    nativeToken: token,
    appName: APP_NAME,
    baseUrl: baseUrl.href,
    context: probeContext,
    excludedChatIds: [...new Set([...hiddenChatsConfig.hiddenChatIds, ...internalChatsConfig.internalChatIds])],
  };
  const blob = new Blob([JSON.stringify(setup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  download(url, SETUP_FILENAME);
  setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS);
}

async function registerProbe(value: unknown) {
  if (isRegistrationBusy) throw new Error('Native probe registration is already running');
  isRegistrationBusy = true;
  try {
    const userId = requireProbeAccount();
    const enrollment = parseEnrollment(value, userId);
    const { token } = await requireNativeToken(userId);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const tokenHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (tokenHash !== enrollment.nativeTokenHash) throw new Error('Native probe targets a different installation');

    const saved = await PROBE_STORE.get<ProbeRegistration>(userId);
    ensureProbeAccount(userId);
    const registrationToken = JSON.stringify(enrollment.subscription);
    if (saved && saved.token !== registrationToken) {
      const hasUnregistered = await callApi('unregisterDevice', saved.token, TELEGRAM_TOKEN_TYPE_WEB_PUSH);
      ensureProbeAccount(userId);
      if (hasUnregistered !== true) throw new Error('Previous native probe cleanup failed');
    }

    const registration: ProbeRegistration = { userId, token: registrationToken, expiresAt: enrollment.expiresAt };
    await PROBE_STORE.set(userId, registration);
    ensureProbeAccount(userId);
    if (Date.now() >= enrollment.expiresAt) throw new Error('Native probe enrollment expired');
    const hasRegistered = await callApi('registerDevice', registrationToken, TELEGRAM_TOKEN_TYPE_WEB_PUSH);
    ensureProbeAccount(userId);
    if (hasRegistered !== true) throw new Error('Telegram did not acknowledge native probe registration');
    return true;
  } finally {
    isRegistrationBusy = false;
  }
}

async function unregisterProbe() {
  if (isRegistrationBusy) throw new Error('Native probe registration is already running');
  isRegistrationBusy = true;
  try {
    const userId = requireProbeAccount();
    const saved = await PROBE_STORE.get<ProbeRegistration>(userId);
    ensureProbeAccount(userId);
    if (!saved) return true;
    const hasUnregistered = await callApi('unregisterDevice', saved.token, TELEGRAM_TOKEN_TYPE_WEB_PUSH);
    ensureProbeAccount(userId);
    if (hasUnregistered !== true) throw new Error('Telegram did not acknowledge native probe removal');
    await PROBE_STORE.del(userId);
    return true;
  } finally {
    isRegistrationBusy = false;
  }
}

function parseEnrollment(value: unknown, userId: string): ProbeEnrollment {
  if (!value || typeof value !== 'object') throw new Error('Invalid native probe enrollment');
  const enrollment = value as Partial<ProbeEnrollment>;
  const now = Date.now();
  if (enrollment.userId !== userId || !/^[a-f0-9]{64}$/.test(enrollment.nativeTokenHash || '')
    || typeof enrollment.expiresAt !== 'number' || !Number.isSafeInteger(enrollment.expiresAt)
    || enrollment.expiresAt <= now || enrollment.expiresAt > now + MAX_PROBE_LIFETIME_MS
    || !enrollment.subscription || typeof enrollment.subscription.endpoint !== 'string'
    || typeof enrollment.subscription.keys?.p256dh !== 'string'
    || typeof enrollment.subscription.keys.auth !== 'string') {
    throw new Error('Invalid or expired native probe enrollment');
  }
  const endpoint = new URL(enrollment.subscription.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !/^\/telegram-push\/[a-zA-Z0-9_-]{32,}$/.test(endpoint.pathname)
    || !/^[a-zA-Z0-9_-]{87}$/.test(enrollment.subscription.keys.p256dh)
    || !/^[a-zA-Z0-9_-]{22}$/.test(enrollment.subscription.keys.auth)) {
    throw new Error('Invalid native probe subscription');
  }
  return {
    userId,
    nativeTokenHash: enrollment.nativeTokenHash!,
    expiresAt: enrollment.expiresAt,
    subscription: {
      endpoint: endpoint.href,
      keys: { p256dh: enrollment.subscription.keys.p256dh, auth: enrollment.subscription.keys.auth },
    },
  };
}

async function requireNativeToken(userId: string) {
  const state = await getNativelyPushState();
  ensureProbeAccount(userId);
  if (!state.hasPermission || !state.token) throw new Error('Native notification permission and token are required');
  return { token: state.token };
}

function requireProbeAccount() {
  const global = getGlobal();
  if (!IS_BETA || !checkIfNativelyApp() || !global.isInited || !global.currentUserId) {
    throw new Error('Native push probe requires a signed-in staging APK');
  }
  return global.currentUserId;
}

function ensureProbeAccount(userId: string) {
  if (requireProbeAccount() !== userId) throw new Error('Native probe account changed');
}
