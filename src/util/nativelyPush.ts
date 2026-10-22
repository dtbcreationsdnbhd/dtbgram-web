import { getActions, getGlobal } from '../global';

import type { PushDiagnosticTrace } from './pushDiagnostics';
import type { PushNotificationContext } from './pushNotificationContext';

import { APP_NAME, NATIVE_PUSH_RELAY_URL, TELEGRAM_TOKEN_TYPE_WEB_PUSH } from '../config';
import { callApi } from '../api/gramjs';
import hiddenChatsConfig from '../hiddenChats.json';
import internalChatsConfig from '../internalChats.json';
import { IdbStore } from './browser/idb';
import { isChatHidden } from './hiddenChats';
import { isInternalChat } from './internalChats';
import { getTranslationFn } from './localization';
import {
  checkIfNativelyApp, getNativelyPushState, requestNativelyPushPermission,
} from './natively';
import { createPushDiagnosticTrace, flushPushDiagnosticTrace, recordPushDiagnosticStep } from './pushDiagnostics';
import { getPushNotificationContext } from './pushNotificationContext';

type NativeSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

type NativePushSetup = {
  userId: string;
  nativeToken: string;
  appName: string;
  baseUrl: string;
  excludedChatIds: string[];
  context: PushNotificationContext;
};

type NativePushRegistration = {
  id: string;
  managementSecret: string;
  userId: string;
  nativeToken: string;
  relayOrigin: string;
  expiresAt?: number;
  telegramToken?: string;
  isActivated?: boolean;
};

type NativePushDevice = {
  id: string;
  status: 'pending' | 'confirmed' | 'active';
  expiresAt: number;
  subscription?: NativeSubscription;
};

const NATIVE_PUSH_STORE = new IdbStore('tt-native-push');
const REGISTRATION_KEY = 'registration';
const PAIRING_HASH_KEY = 'nativePushPair';
const CAPABILITY_BYTES = 32;
const CAPABILITY_PATTERN = /^[a-zA-Z0-9_-]{43}$/;
const REQUEST_TIMEOUT_MS = 15000;
const PAIRING_BACKGROUND_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_RETRY_DELAYS_MS = [500, 1500];
const MAX_RESPONSE_CHARACTERS = 16384;
const POLICY_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const EXCLUDED_CHAT_IDS = [...new Set([...hiddenChatsConfig.hiddenChatIds, ...internalChatsConfig.internalChatIds])];
const ACTIVE_REQUESTS = new Set<AbortController>();

let generation = 0;
let operationQueue: Promise<unknown> = Promise.resolve();
let policyQueue: Promise<unknown> = Promise.resolve();
let latestContext: PushNotificationContext | undefined;
let subscriptionTask: Promise<void> | undefined;
let subscriptionUserId: string | undefined;
let subscriptionGeneration: number | undefined;
let pairingChallenge: { id: string; challenge: string } | undefined;
let lastContext = '';
let lastContextUpdatedAt = 0;

export function checkIfNativePushEnabled() {
  if (!checkIfNativelyApp() || !NATIVE_PUSH_RELAY_URL) return false;
  try {
    parseRelayOrigin(NATIVE_PUSH_RELAY_URL);
    return true;
  } catch {
    return false;
  }
}

export function consumeNativePushPairing(hash = window.location.hash) {
  if (!checkIfNativePushEnabled()) return false;
  const value = new URLSearchParams(hash.replace(/^#/, '')).get(PAIRING_HASH_KEY);
  if (!value) return false;
  if (window.location.hash === hash) {
    const url = new URL(window.location.href);
    url.hash = '';
    window.history.replaceState(window.history.state, '', url.href);
  }
  const [id, challenge, extra] = value.split('.');
  if (extra !== undefined || !CAPABILITY_PATTERN.test(id) || !CAPABILITY_PATTERN.test(challenge)) return false;
  pairingChallenge = { id, challenge };
  return true;
}

export function subscribeNativePush(): Promise<void> {
  if (!checkIfNativePushEnabled()) return Promise.resolve();
  const userId = getGlobal().currentUserId;
  if (!userId || !getGlobal().isInited) return Promise.resolve();
  const expectedGeneration = generation;
  if (subscriptionTask && subscriptionUserId === userId && subscriptionGeneration === expectedGeneration) {
    return subscriptionTask;
  }
  const trace = createPushDiagnosticTrace('nativeSubscribe');
  let hasSucceeded = false;
  recordPushDiagnosticStep(trace, 'nativeSubscribeRequested');
  const task = enqueueOperation(() => registerNativePush(userId, expectedGeneration, trace)).then(() => {
    hasSucceeded = true;
  }).catch((err: unknown) => {
    recordPushDiagnosticStep(trace, 'nativeSubscribeFailed', {
      errorName: err instanceof Error ? err.name : 'UnknownError',
    });
    if (generation === expectedGeneration && getGlobal().currentUserId === userId) {
      getActions().showNotification({ message: getTranslationFn()('NativePushFailed') });
    }
    throw err;
  }).finally(async () => {
    if (subscriptionTask === task) {
      subscriptionTask = undefined;
      subscriptionUserId = undefined;
      subscriptionGeneration = undefined;
      if (hasSucceeded && pairingChallenge && generation === expectedGeneration
        && getGlobal().currentUserId === userId) {
        void subscribeNativePush().catch(() => undefined);
      }
    }
    await flushPushDiagnosticTrace(trace);
  });
  subscriptionTask = task;
  subscriptionUserId = userId;
  subscriptionGeneration = expectedGeneration;
  return task;
}

export function unsubscribeNativePush(): Promise<void> {
  generation += 1;
  ACTIVE_REQUESTS.forEach((controller) => controller.abort());
  pairingChallenge = undefined;
  lastContext = '';
  lastContextUpdatedAt = 0;
  return enqueueOperation(async () => {
    const registration = await NATIVE_PUSH_STORE.get<NativePushRegistration>(REGISTRATION_KEY);
    if (!registration) return;
    await revokeRegistration(registration);
  });
}

export function synchronizeNativePushContext(context: PushNotificationContext): Promise<void> {
  latestContext = context;
  if (!checkIfNativePushEnabled() || !context.userId) return Promise.resolve();
  const userId = context.userId;
  const expectedGeneration = generation;
  return (async () => {
    if (generation !== expectedGeneration || getGlobal().currentUserId !== userId) return;
    const registration = await NATIVE_PUSH_STORE.get<NativePushRegistration>(REGISTRATION_KEY);
    ensureAccount(userId, expectedGeneration);
    if (!registration || registration.userId !== userId || !registration.telegramToken) return;
    await synchronizeRegistrationPolicy(registration, context, expectedGeneration);
  })();
}

export async function getNativePushStatus() {
  if (!checkIfNativePushEnabled()) return 'disabled';
  const registration = await NATIVE_PUSH_STORE.get<NativePushRegistration>(REGISTRATION_KEY);
  if (!registration || registration.userId !== getGlobal().currentUserId) return 'unpaired';
  if (registration.expiresAt && Date.now() >= registration.expiresAt) return 'unpaired';
  const nativeState = await getNativelyPushState();
  if (!nativeState.hasPermission || nativeState.token !== registration.nativeToken) return 'unpaired';
  return registration.isActivated ? 'active' : 'pending';
}

async function registerNativePush(userId: string, expectedGeneration: number, trace: PushDiagnosticTrace) {
  ensureAccount(userId, expectedGeneration);
  let nativeState = await getNativelyPushState();
  ensureAccount(userId, expectedGeneration);
  if (!nativeState.hasPermission) {
    const hasPermission = await requestNativelyPushPermission();
    ensureAccount(userId, expectedGeneration);
    if (!hasPermission) throw new Error('Native notification permission is required');
    nativeState = await getNativelyPushState();
    ensureAccount(userId, expectedGeneration);
  }
  recordPushDiagnosticStep(trace, 'nativePermissionChecked', { hasFcmToken: Boolean(nativeState.token) });
  if (!nativeState.hasPermission || !nativeState.token) throw new Error('Native notification token is unavailable');
  const relayOrigin = parseRelayOrigin(NATIVE_PUSH_RELAY_URL);
  const context = await getPushNotificationContext();
  ensureAccount(userId, expectedGeneration);
  if (context?.userId !== userId) throw new Error('Native notification privacy settings are unavailable');
  let registration = await NATIVE_PUSH_STORE.get<NativePushRegistration>(REGISTRATION_KEY);
  ensureAccount(userId, expectedGeneration);
  if (registration && (registration.userId !== userId || registration.nativeToken !== nativeState.token
    || registration.relayOrigin !== relayOrigin)) {
    await revokeRegistration(registration);
    ensureAccount(userId, expectedGeneration);
    registration = undefined;
  }
  if (!registration) {
    registration = {
      id: createCapability(),
      managementSecret: createCapability(),
      userId,
      nativeToken: nativeState.token,
      relayOrigin,
    };
    await NATIVE_PUSH_STORE.set(REGISTRATION_KEY, registration);
    ensureAccount(userId, expectedGeneration);
  }
  const setup = buildSetup(registration, context);
  let device = await readDevice(registration);
  ensureAccount(userId, expectedGeneration);
  if (!device) {
    if (registration.telegramToken) {
      const hasUnregistered = await runTelegramTask(
        callApi('unregisterDevice', registration.telegramToken, TELEGRAM_TOKEN_TYPE_WEB_PUSH),
      );
      ensureAccount(userId, expectedGeneration);
      if (hasUnregistered !== true) throw new Error('Expired native Telegram registration cleanup failed');
    }
    if (registration.expiresAt || registration.telegramToken) {
      registration = {
        id: createCapability(),
        managementSecret: createCapability(),
        userId,
        nativeToken: nativeState.token,
        relayOrigin,
      };
      await NATIVE_PUSH_STORE.set(REGISTRATION_KEY, registration);
      ensureAccount(userId, expectedGeneration);
    }
    recordPushDiagnosticStep(trace, 'nativePairingAwaitingBackground');
    getActions().showNotification({ message: getTranslationFn()('NativePushPairBackground') });
    await waitForNativePushBackground();
    ensureAccount(userId, expectedGeneration);
    const response = await requestRelay(registration.relayOrigin, '/native-push/pairings', 'POST', undefined, {
      id: registration.id,
      managementSecret: registration.managementSecret,
      setup,
    });
    ensureAccount(userId, expectedGeneration);
    if (!isRecord(response) || response.id !== registration.id || !isFutureTimestamp(response.expiresAt)) {
      throw new Error('Invalid native notification pairing response');
    }
    registration.expiresAt = response.expiresAt;
    await NATIVE_PUSH_STORE.set(REGISTRATION_KEY, registration);
    ensureAccount(userId, expectedGeneration);
    recordPushDiagnosticStep(trace, 'nativePairingPending');
    getActions().showNotification({ message: getTranslationFn()('NativePushPairPending') });
    return;
  }
  if (pairingChallenge && (pairingChallenge.id !== registration.id || device.status !== 'pending')) {
    pairingChallenge = undefined;
  }
  if (device.status === 'pending') {
    const challenge = pairingChallenge;
    if (!challenge || challenge.id !== registration.id) return;
    const currentNativeState = await getNativelyPushState();
    ensureAccount(userId, expectedGeneration);
    if (!currentNativeState.hasPermission || currentNativeState.token !== registration.nativeToken) {
      throw new Error('Native notification installation changed');
    }
    device = parseDevice(await requestDevice(registration, 'POST', { challenge: challenge.challenge }, '/confirm'),
      registration);
    ensureAccount(userId, expectedGeneration);
    if (pairingChallenge === challenge) pairingChallenge = undefined;
    recordPushDiagnosticStep(trace, 'nativePairingConfirmed');
  }
  if (!device.subscription || device.status === 'pending') throw new Error('Native notification pairing is incomplete');
  await synchronizeRegistrationPolicy(registration, context, expectedGeneration);
  ensureAccount(userId, expectedGeneration);
  const telegramToken = JSON.stringify(device.subscription);
  if (device.status === 'active' && registration.telegramToken === telegramToken) {
    registration.isActivated = true;
    registration.expiresAt = device.expiresAt;
    await NATIVE_PUSH_STORE.set(REGISTRATION_KEY, registration);
    ensureAccount(userId, expectedGeneration);
    recordPushDiagnosticStep(trace, 'nativeRelayActive');
    return;
  }
  if (registration.telegramToken && registration.telegramToken !== telegramToken) {
    const hasUnregistered = await runTelegramTask(
      callApi('unregisterDevice', registration.telegramToken, TELEGRAM_TOKEN_TYPE_WEB_PUSH),
    );
    ensureAccount(userId, expectedGeneration);
    if (hasUnregistered !== true) throw new Error('Previous native Telegram registration cleanup failed');
  }
  registration.telegramToken = telegramToken;
  registration.isActivated = false;
  await NATIVE_PUSH_STORE.set(REGISTRATION_KEY, registration);
  ensureAccount(userId, expectedGeneration);
  const hasRegistered = await runTelegramTask(callApi('registerDevice', telegramToken, TELEGRAM_TOKEN_TYPE_WEB_PUSH));
  ensureAccount(userId, expectedGeneration);
  if (hasRegistered !== true) throw new Error('Telegram did not acknowledge native notifications');
  recordPushDiagnosticStep(trace, 'nativeTelegramRegistered', { isRegistrationSuccessful: true });
  await synchronizeRegistrationPolicy(registration, context, expectedGeneration);
  ensureAccount(userId, expectedGeneration);
  await requestDevice(registration, 'POST', undefined, '/activate');
  ensureAccount(userId, expectedGeneration);
  registration.isActivated = true;
  registration.expiresAt = device.expiresAt;
  await NATIVE_PUSH_STORE.set(REGISTRATION_KEY, registration);
  ensureAccount(userId, expectedGeneration);
  recordPushDiagnosticStep(trace, 'nativeRelayActivated');
  if (device.status !== 'active') getActions().showNotification({ message: getTranslationFn()('NativePushEnabled') });
}

function waitForNativePushBackground(): Promise<void> {
  if (document.visibilityState === 'hidden') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    ACTIVE_REQUESTS.add(controller);
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Native notification background setup timed out'));
    }, PAIRING_BACKGROUND_TIMEOUT_MS);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    controller.signal.addEventListener('abort', handleAbort);
    handleVisibilityChange();

    function handleVisibilityChange() {
      if (document.visibilityState !== 'hidden') return;
      cleanup();
      resolve();
    }

    function handleAbort() {
      cleanup();
      reject(new DOMException('Native notification setup was cancelled', 'AbortError'));
    }

    function cleanup() {
      window.clearTimeout(timeout);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      controller.signal.removeEventListener('abort', handleAbort);
      ACTIVE_REQUESTS.delete(controller);
    }
  });
}

function synchronizeRegistrationPolicy(
  registration: NativePushRegistration, context: PushNotificationContext, expectedGeneration: number,
) {
  const task = policyQueue.then(async () => {
    ensureAccount(registration.userId, expectedGeneration);
    const currentContext = latestContext?.userId === registration.userId ? latestContext : context;
    const setup = buildSetup(registration, currentContext);
    const serializedContext = JSON.stringify({ id: registration.id, context: setup.context });
    if (serializedContext === lastContext && Date.now() - lastContextUpdatedAt < POLICY_REFRESH_INTERVAL_MS) return;
    await requestDevice(registration, 'PATCH', { setup });
    ensureAccount(registration.userId, expectedGeneration);
    lastContext = serializedContext;
    lastContextUpdatedAt = Date.now();
  });
  policyQueue = task.catch(() => undefined);
  return task;
}

async function revokeRegistration(registration: NativePushRegistration) {
  await requestDevice(registration, 'DELETE');
  if (registration.telegramToken && getGlobal().currentUserId === registration.userId) {
    await runTelegramTask(callApi('unregisterDevice', registration.telegramToken, TELEGRAM_TOKEN_TYPE_WEB_PUSH));
  }
  const current = await NATIVE_PUSH_STORE.get<NativePushRegistration>(REGISTRATION_KEY);
  if (current?.id === registration.id) await NATIVE_PUSH_STORE.del(REGISTRATION_KEY);
}

async function readDevice(registration: NativePushRegistration) {
  const response = await requestDevice(registration, 'GET');
  return response === undefined ? undefined : parseDevice(response, registration);
}

function parseDevice(value: unknown, registration: NativePushRegistration): NativePushDevice {
  if (!isRecord(value) || value.id !== registration.id
    || (value.status !== 'pending' && value.status !== 'confirmed' && value.status !== 'active')
    || !isFutureTimestamp(value.expiresAt)) throw new Error('Invalid native notification registration');
  const { status } = value;
  let subscription: NativeSubscription | undefined;
  if (status !== 'pending') {
    if (!isRecord(value.subscription) || !isRecord(value.subscription.keys)
      || typeof value.subscription.endpoint !== 'string') {
      throw new Error('Invalid native Telegram subscription');
    }
    const endpoint = new URL(value.subscription.endpoint);
    const { p256dh, auth } = value.subscription.keys;
    if (endpoint.origin !== registration.relayOrigin || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || !/^\/telegram-push\/[a-zA-Z0-9_-]{43}$/.test(endpoint.pathname)
      || typeof p256dh !== 'string' || !/^[a-zA-Z0-9_-]{87}$/.test(p256dh)
      || typeof auth !== 'string' || !/^[a-zA-Z0-9_-]{22}$/.test(auth)) {
      throw new Error('Invalid native Telegram subscription');
    }
    subscription = { endpoint: endpoint.href, keys: { p256dh, auth } };
  }
  return { id: registration.id, status, expiresAt: value.expiresAt, subscription };
}

function buildSetup(registration: NativePushRegistration, context: PushNotificationContext): NativePushSetup {
  const shouldShowPreviewsByChatId = { ...context.shouldShowPreviewsByChatId };
  Object.keys(shouldShowPreviewsByChatId).forEach((chatId) => {
    if (isChatHidden(chatId) || isInternalChat(chatId)) shouldShowPreviewsByChatId[chatId] = false;
  });
  const baseUrl = new URL(window.location.href);
  baseUrl.hash = '';
  baseUrl.search = '';
  return {
    userId: registration.userId,
    nativeToken: registration.nativeToken,
    appName: APP_NAME,
    baseUrl: baseUrl.href,
    excludedChatIds: EXCLUDED_CHAT_IDS,
    context: { ...context, shouldShowPreviewsByChatId },
  };
}

function requestDevice(
  registration: NativePushRegistration, method: string, body?: unknown, suffix = '',
) {
  return requestRelay(registration.relayOrigin, `/native-push/devices/${registration.id}${suffix}`,
    method, registration.managementSecret, body);
}

async function requestRelay(origin: string, path: string, method: string, secret?: string, body?: unknown) {
  const controller = new AbortController();
  ACTIVE_REQUESTS.add(controller);
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (secret) headers.Authorization = `Bearer ${secret}`;
    const options: RequestInit = {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    };
    const response = await fetchRelayResponse(`${origin}${path}`, options);
    if (response.status === 404 || response.status === 410) {
      if (method === 'GET' || method === 'DELETE') return undefined;
    }
    if (!response.ok) throw new Error(`Native notification relay request failed (HTTP ${response.status})`);
    if (response.status === 204) return undefined;
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARACTERS) throw new Error('Invalid native notification relay response');
    return text ? JSON.parse(text) as unknown : undefined;
  } finally {
    ACTIVE_REQUESTS.delete(controller);
    window.clearTimeout(timeout);
  }
}

async function fetchRelayResponse(url: string, options: RequestInit) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, options);
    if ((response.status !== 409 && response.status !== 503) || attempt >= REQUEST_RETRY_DELAYS_MS.length) {
      return response;
    }
    await response.body?.cancel();
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, REQUEST_RETRY_DELAYS_MS[attempt]);
    });
  }
}

function enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
  const task = operationQueue.then(operation, operation);
  operationQueue = task.catch(() => undefined);
  return task;
}

async function runTelegramTask<T>(task: Promise<T>) {
  let timeout: number | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((resolve, reject) => {
        timeout = window.setTimeout(() => reject(new Error('Native Telegram registration timed out')),
          REQUEST_TIMEOUT_MS);
      }),
    ]);
  } finally {
    window.clearTimeout(timeout);
  }
}

function ensureAccount(userId: string, expectedGeneration: number) {
  const global = getGlobal();
  if (generation !== expectedGeneration || global.currentUserId !== userId || !global.isInited) {
    throw new Error('Native notification account changed');
  }
}

function parseRelayOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Native notification relay must be an HTTPS origin');
  }
  return url.origin;
}

function createCapability() {
  const bytes = crypto.getRandomValues(new Uint8Array(CAPABILITY_BYTES));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isFutureTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
