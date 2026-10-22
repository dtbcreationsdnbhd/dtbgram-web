import { addCallback } from '../lib/teact/teactn';
import { getActions, getGlobal } from '../global';

import type { GlobalState } from '../global/types';

import { DEBUG, DEBUG_MORE, IS_TEST } from '../config';
import { callApi } from '../api/gramjs';
// eslint-disable-next-line import-x/default
import serviceWorkerUrl from '../serviceWorker/service.worker.ts?worker&url';
import { IS_ANDROID, IS_IOS, IS_SERVICE_WORKER_SUPPORTED } from './browser/windowEnvironment';
import { formatShareText } from './deeplink';
import { validateFiles } from './files';
import { addLocalizationCallback } from './localization';
import { checkIfNativePushEnabled, consumeNativePushPairing } from './nativelyPush';
import {
  checkIfOfflinePushFailed, notifyClientReady, playNotifySoundDebounced, refreshPushNotificationContext, subscribe,
} from './notifications';
import {
  capturePushDiagnosticSnapshot, createPushDiagnosticTrace, flushPushDiagnosticTrace, recordPushDiagnosticStep,
} from './pushDiagnostics';
import { throttle } from './schedulers';

type WorkerAction = {
  type: string;
  payload: Record<string, any>;
};

const SW_CLAIM_RELOAD_KEY = 'tt-sw-claim-reload';
const CONTROLLER_WAIT_MS = 4000;
const PUSH_DIAGNOSTIC_READ_TIMEOUT_MS = 2000;
const PUSH_CHAT_CONTEXT_REFRESH_MS = 200;
const SERVICE_WORKER_OPTIONS: RegistrationOptions = import.meta.env.DEV
  ? { scope: './', type: 'module' }
  : { type: 'module' };
const refreshPushChatContextThrottled = throttle(refreshPushNotificationContext, PUSH_CHAT_CONTEXT_REFRESH_MS, false);

let previousGlobal: GlobalState | undefined;
let notificationCleanupTimeout: number | undefined;

function handlePushContextChange(global: GlobalState) {
  const oldGlobal = previousGlobal;
  previousGlobal = global;
  if (!global.isInited) return;
  if (oldGlobal?.isInited && oldGlobal.currentUserId === global.currentUserId
    && oldGlobal.passcode.isScreenLocked === global.passcode.isScreenLocked
    && oldGlobal.passcode.hasPasscode === global.passcode.hasPasscode
    && oldGlobal.settings.byKey.hasWebNotifications === global.settings.byKey.hasWebNotifications
    && oldGlobal.settings.notifyDefaults === global.settings.notifyDefaults
    && oldGlobal.chats.notifyExceptionById === global.chats.notifyExceptionById) {
    if (oldGlobal.chats.byId !== global.chats.byId || (checkIfNativePushEnabled()
      && (oldGlobal.messages.byChatId !== global.messages.byChatId
        || oldGlobal.chats.lastMessageIds !== global.chats.lastMessageIds))) refreshPushChatContextThrottled();
    return;
  }

  void refreshPushNotificationContext();
  if (checkIfNativePushEnabled()
    && (!oldGlobal?.isInited || oldGlobal.currentUserId !== global.currentUserId)) void subscribe();
}

function handleWorkerMessage(e: MessageEvent) {
  const action: WorkerAction = e.data;
  if (DEBUG_MORE) {
    // eslint-disable-next-line no-console
    console.log('[SW] Message from worker', action);
  }
  if (!action.type) return;
  const dispatch = getActions();
  const payload = action.payload;
  if (payload?.userId && payload.userId !== getGlobal().currentUserId) return;
  switch (action.type) {
    case 'focusMessage':
      if (payload.messageId) {
        dispatch.focusMessage?.(payload as any);
      } else if (payload.chatId) {
        dispatch.openChat({ id: payload.chatId });
      }
      break;
    case 'focusStory':
      dispatch.openStoryViewer({ peerId: payload.chatId, storyId: payload.storyId });
      break;
    case 'pushStateUpdate':
      if (payload.notificationType === 'SESSION_REVOKE') {
        void callApi('fetchCurrentUser');
      } else if (payload.notificationType === 'DC_UPDATE') {
        dispatch.loadConfig();
      } else if (payload.notificationType === 'AUTH_UNKNOWN' || payload.notificationType === 'AUTH_REGION') {
        dispatch.loadAuthorizations();
      }
      break;
    case 'playNotificationSound':
      playNotifySoundDebounced(action.payload.id);
      break;
    case 'scheduleNotificationCleanup':
      if (typeof payload?.cleanupAt === 'number' && Number.isFinite(payload.cleanupAt)) {
        scheduleNotificationCleanup(payload.cleanupAt);
      }
      break;
    case 'share':
      dispatch.openChatWithDraft({
        text: formatShareText(payload.url, payload.text, payload.title),
        files: validateFiles(payload.files),
      });
      break;
  }
}

function scheduleNotificationCleanup(cleanupAt: number) {
  window.clearTimeout(notificationCleanupTimeout);
  notificationCleanupTimeout = window.setTimeout(() => {
    notificationCleanupTimeout = undefined;
    const controller = navigator.serviceWorker.controller;
    if (controller) controller.postMessage({ type: 'cleanupMessageNotifications' });
  }, Math.max(0, cleanupAt - Date.now()));
}

async function subscribeToWorker() {
  navigator.serviceWorker.removeEventListener('message', handleWorkerMessage);
  navigator.serviceWorker.addEventListener('message', handleWorkerMessage);
  await refreshPushNotificationContext();
  // Notify web worker that client is ready to receive messages
  notifyClientReady();
}

function waitForController() {
  if (navigator.serviceWorker.controller) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    const finish = () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      window.clearTimeout(timeout);
      resolve(Boolean(navigator.serviceWorker.controller));
    };
    const onChange = () => finish();
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
    const timeout = window.setTimeout(finish, CONTROLLER_WAIT_MS);
  });
}

async function registerServiceWorker() {
  try {
    await recordPagePushState('pageStartup');
    const registration = await navigator.serviceWorker.register(serviceWorkerUrl, SERVICE_WORKER_OPTIONS);
    await capturePushDiagnosticSnapshot('workerRegistered', registration);

    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log('[SW] ServiceWorker registered');
    }

    await navigator.serviceWorker.ready;
    await navigator.serviceWorker.getRegistration();
    await waitForController();

    if (navigator.serviceWorker.controller) {
      sessionStorage.removeItem(SW_CLAIM_RELOAD_KEY);
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.log('[SW] ServiceWorker ready');
      }
      await subscribeToWorker();
      return;
    }

    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.error('[SW] ServiceWorker not available');
    }

    if (!sessionStorage.getItem(SW_CLAIM_RELOAD_KEY)) {
      sessionStorage.setItem(SW_CLAIM_RELOAD_KEY, '1');
      window.location.reload();
      return;
    }

    if (!IS_IOS && !IS_ANDROID && !IS_TEST) {
      getActions().showDialog?.({ data: { type: 'error', message: 'SERVICE_WORKER_DISABLED', hasErrorKey: true } });
    }
  } catch (err) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.error('[SW] ServiceWorker registration failed: ', err);
    }
  }
}

if (IS_SERVICE_WORKER_SUPPORTED || checkIfNativePushEnabled()) {
  addCallback(handlePushContextChange);
  addLocalizationCallback(refreshPushNotificationContext);
}

if (checkIfNativePushEnabled()) {
  window.addEventListener('hashchange', () => {
    if (consumeNativePushPairing()) void subscribe();
  });
  window.addEventListener('focus', () => {
    void subscribe();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void subscribe();
  });
}

if (IS_SERVICE_WORKER_SUPPORTED) {
  if (document.readyState === 'loading') {
    window.addEventListener('load', registerServiceWorker);
  } else {
    void registerServiceWorker();
  }

  window.addEventListener('focus', async () => {
    const registration = await navigator.serviceWorker.ready;
    void capturePushDiagnosticSnapshot('pageFocus', registration, {
      isAppVisible: document.visibilityState === 'visible',
    });
    await subscribeToWorker();
    if (checkIfOfflinePushFailed()) void subscribe();
  });

  document.addEventListener('visibilitychange', async () => {
    await refreshPushNotificationContext();
    if (document.visibilityState === 'visible') notifyClientReady();
    void recordPagePushState('pageVisibility');
  });
}

async function recordPagePushState(source: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      capturePagePushState(source),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, PUSH_DIAGNOSTIC_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function capturePagePushState(source: string) {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration) {
      await capturePushDiagnosticSnapshot(source, registration, {
        isAppVisible: document.visibilityState === 'visible',
      });
      return;
    }

    const trace = createPushDiagnosticTrace(source);
    recordPushDiagnosticStep(trace, 'noRegistration', {
      permission: typeof Notification !== 'undefined' ? Notification.permission : undefined,
      hasSubscription: false,
      isAppVisible: document.visibilityState === 'visible',
    });
    await flushPushDiagnosticTrace(trace);
  } catch {
    // Diagnostic reads do not interrupt worker registration
  }
}
