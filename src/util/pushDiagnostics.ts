import { APP_ENV, DEBUG } from '../config';
import { IdbStore } from './browser/idb';

export type PushDiagnosticDetails = {
  permission?: NotificationPermission;
  scope?: string;
  workerUrl?: string;
  activeWorkerUrl?: string;
  workerState?: ServiceWorkerState;
  errorName?: string;
  errorMessage?: string;
  isAppVisible?: boolean;
  hasSubscription?: boolean;
  subscriptionExpiresAt?: number;
  hasOldSubscription?: boolean;
  hasNewSubscription?: boolean;
  hasSavedDeviceToken?: boolean;
  hasFcmToken?: boolean;
  subscribedAt?: number;
  isRegistrationSuccessful?: boolean;
  doesSubscriptionMatchSaved?: boolean;
  hasNotificationRequestResolved?: boolean;
  skipReason?: string;
  notificationType?: string;
};

export type PushDiagnosticTrace = {
  id: string;
  source: string;
  startedAt: number;
  shouldCollectPromise: Promise<boolean>;
  pendingWrite: Promise<void>;
};

type PushDiagnosticStep = PushDiagnosticDetails & {
  timestamp: number;
  status: string;
};

type PushDiagnosticEvent = {
  id: string;
  source: string;
  startedAt: number;
  steps: PushDiagnosticStep[];
};

const PUSH_DIAGNOSTIC_STORE = new IdbStore('tt-push-diagnostics');
const ENABLED_KEY = 'shouldCollect';
const EVENT_KEY_PREFIX = 'event:';
const MAX_EVENTS = 1000;
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STEPS_PER_EVENT = 64;
const MAX_TEXT_LENGTH = 256;
const DIAGNOSTIC_TIMEOUT_MS = 2000;

export function getShouldCollectPushDiagnostics() {
  return PUSH_DIAGNOSTIC_STORE.get<boolean>(ENABLED_KEY).then((shouldCollect) => shouldCollect ?? DEBUG);
}

export function setShouldCollectPushDiagnostics(shouldCollect: boolean) {
  return PUSH_DIAGNOSTIC_STORE.set(ENABLED_KEY, shouldCollect);
}

export async function getPushDiagnosticReport() {
  const keys = await prunePushDiagnosticEvents();
  const events = await PUSH_DIAGNOSTIC_STORE.getMany<PushDiagnosticEvent>(keys);
  const shouldCollect = await getShouldCollectPushDiagnostics();
  const recordedEvents = events.filter(Boolean).sort((first, second) => first.startedAt - second.startedAt);
  const pushesWithoutNotification = recordedEvents.filter((event) => event.source === 'push'
    && event.steps.some((step) => step.status === 'pushCompletedWithoutNotification')).length;

  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    appEnv: APP_ENV,
    userAgent: navigator.userAgent,
    shouldCollect,
    maxEvents: MAX_EVENTS,
    maxEventAgeMs: MAX_EVENT_AGE_MS,
    pushesWithoutNotification,
    events: recordedEvents,
  }, undefined, 2);
}

export async function clearPushDiagnostics() {
  const keys = await getPushDiagnosticEventKeys();
  await PUSH_DIAGNOSTIC_STORE.delMany(keys);
}

export function createPushDiagnosticTrace(source: string): PushDiagnosticTrace {
  return {
    id: crypto.randomUUID(),
    source: source.slice(0, MAX_TEXT_LENGTH),
    startedAt: Date.now(),
    shouldCollectPromise: getShouldCollectPushDiagnostics().catch((err: unknown) => {
      logPushDiagnosticStorageError(err);
      return false;
    }),
    pendingWrite: Promise.resolve(),
  };
}

export function recordPushDiagnosticStep(
  trace: PushDiagnosticTrace, status: string, details?: PushDiagnosticDetails,
) {
  const step: PushDiagnosticStep = {
    timestamp: Date.now(),
    status: status.slice(0, MAX_TEXT_LENGTH),
    permission: details?.permission,
    scope: sanitizeDiagnosticUrl(details?.scope),
    workerUrl: sanitizeDiagnosticUrl(details?.workerUrl),
    activeWorkerUrl: sanitizeDiagnosticUrl(details?.activeWorkerUrl),
    workerState: details?.workerState,
    errorName: details?.errorName?.slice(0, MAX_TEXT_LENGTH),
    errorMessage: details?.errorMessage?.slice(0, MAX_TEXT_LENGTH),
    isAppVisible: details?.isAppVisible,
    hasSubscription: details?.hasSubscription,
    subscriptionExpiresAt: details?.subscriptionExpiresAt,
    hasOldSubscription: details?.hasOldSubscription,
    hasNewSubscription: details?.hasNewSubscription,
    hasSavedDeviceToken: details?.hasSavedDeviceToken,
    hasFcmToken: details?.hasFcmToken,
    subscribedAt: details?.subscribedAt,
    isRegistrationSuccessful: details?.isRegistrationSuccessful,
    doesSubscriptionMatchSaved: details?.doesSubscriptionMatchSaved,
    hasNotificationRequestResolved: details?.hasNotificationRequestResolved,
    skipReason: details?.skipReason?.slice(0, MAX_TEXT_LENGTH),
    notificationType: details?.notificationType?.slice(0, MAX_TEXT_LENGTH),
  };

  trace.pendingWrite = trace.pendingWrite.then(async () => {
    if (!await trace.shouldCollectPromise) return;

    const key = `${EVENT_KEY_PREFIX}${trace.startedAt}:${trace.id}`;
    await PUSH_DIAGNOSTIC_STORE.update<PushDiagnosticEvent>(key, (event) => ({
      id: trace.id,
      source: trace.source,
      startedAt: trace.startedAt,
      steps: [...(event?.steps || []), step].slice(-MAX_STEPS_PER_EVENT),
    }));
  }).catch(logPushDiagnosticStorageError);
}

export async function flushPushDiagnosticTrace(trace: PushDiagnosticTrace) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutTask = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, DIAGNOSTIC_TIMEOUT_MS);
  });

  try {
    await Promise.race([completePushDiagnosticTrace(trace), timeoutTask]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function capturePushDiagnosticSnapshot(
  source: string, registration: ServiceWorkerRegistration, details?: PushDiagnosticDetails,
) {
  const trace = createPushDiagnosticTrace(source);
  const snapshotDetails: PushDiagnosticDetails = {
    ...details,
    permission: typeof Notification !== 'undefined' ? Notification.permission : undefined,
    scope: registration.scope,
    activeWorkerUrl: registration.active?.scriptURL,
    workerState: registration.active?.state,
  };
  recordPushDiagnosticStep(trace, 'snapshotStarted', snapshotDetails);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutTask = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      recordPushDiagnosticStep(trace, 'snapshotFailed', { ...snapshotDetails, errorName: 'TimeoutError' });
      void flushPushDiagnosticTrace(trace);
      resolve();
    }, DIAGNOSTIC_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      collectPushDiagnosticSnapshot(trace, registration, snapshotDetails),
      timeoutTask,
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function collectPushDiagnosticSnapshot(
  trace: PushDiagnosticTrace, registration: ServiceWorkerRegistration, details: PushDiagnosticDetails,
) {
  try {
    if (await trace.shouldCollectPromise) {
      const subscription = await registration.pushManager.getSubscription();
      recordPushDiagnosticStep(trace, 'snapshotCompleted', {
        ...details,
        hasSubscription: Boolean(subscription),
        subscriptionExpiresAt: subscription?.expirationTime ?? undefined,
      });
    }
  } catch (err) {
    recordPushDiagnosticStep(trace, 'snapshotFailed', {
      ...details,
      errorName: err instanceof Error ? err.name : undefined,
    });
  } finally {
    await flushPushDiagnosticTrace(trace);
  }
}

async function completePushDiagnosticTrace(trace: PushDiagnosticTrace) {
  try {
    await trace.pendingWrite;
    if (await trace.shouldCollectPromise) {
      await prunePushDiagnosticEvents();
    }
  } catch (err) {
    logPushDiagnosticStorageError(err);
  }
}

async function prunePushDiagnosticEvents() {
  const keys = await getPushDiagnosticEventKeys();
  const oldestStartedAt = Date.now() - MAX_EVENT_AGE_MS;
  const retainedKeys = keys.filter((key) => Number(key.slice(EVENT_KEY_PREFIX.length).split(':')[0]) >= oldestStartedAt)
    .slice(-MAX_EVENTS);
  const retainedKeysSet = new Set(retainedKeys);
  const removedKeys = keys.filter((key) => !retainedKeysSet.has(key));
  if (removedKeys.length) {
    await PUSH_DIAGNOSTIC_STORE.delMany(removedKeys);
  }
  return retainedKeys;
}

async function getPushDiagnosticEventKeys() {
  const keys = await PUSH_DIAGNOSTIC_STORE.keys();
  return keys.filter((key): key is string => typeof key === 'string' && key.startsWith(EVENT_KEY_PREFIX)).sort();
}

function sanitizeDiagnosticUrl(value?: string) {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function logPushDiagnosticStorageError(err: unknown) {
  // eslint-disable-next-line no-console
  console.warn('[Push diagnostics] Storage failed', err instanceof Error ? err.name : 'UnknownError');
}
