import { getActions } from '../global';

import { DEBUG, DEBUG_MORE, IS_TEST } from '../config';
// eslint-disable-next-line import-x/default
import serviceWorkerUrl from '../serviceWorker/service.worker.ts?worker&url';
import { IS_ANDROID, IS_IOS, IS_SERVICE_WORKER_SUPPORTED } from './browser/windowEnvironment';
import { formatShareText } from './deeplink';
import { validateFiles } from './files';
import { notifyClientReady, playNotifySoundDebounced } from './notifications';
import {
  capturePushDiagnosticSnapshot, createPushDiagnosticTrace, flushPushDiagnosticTrace, recordPushDiagnosticStep,
} from './pushDiagnostics';

type WorkerAction = {
  type: string;
  payload: Record<string, any>;
};

const IGNORE_WORKER_PATH = '/k/';
const SW_CLAIM_RELOAD_KEY = 'tt-sw-claim-reload';
const CONTROLLER_WAIT_MS = 4000;
const PUSH_DIAGNOSTIC_READ_TIMEOUT_MS = 2000;
const SERVICE_WORKER_OPTIONS: RegistrationOptions = import.meta.env.DEV
  ? { scope: './', type: 'module' }
  : { type: 'module' };

function handleWorkerMessage(e: MessageEvent) {
  const action: WorkerAction = e.data;
  if (DEBUG_MORE) {
    // eslint-disable-next-line no-console
    console.log('[SW] Message from worker', action);
  }
  if (!action.type) return;
  const dispatch = getActions();
  const payload = action.payload;
  switch (action.type) {
    case 'focusMessage':
      dispatch.focusMessage?.(payload as any);
      break;
    case 'playNotificationSound':
      playNotifySoundDebounced(action.payload.id);
      break;
    case 'share':
      dispatch.openChatWithDraft({
        text: formatShareText(payload.url, payload.text, payload.title),
        files: validateFiles(payload.files),
      });
      break;
  }
}

function subscribeToWorker() {
  navigator.serviceWorker.removeEventListener('message', handleWorkerMessage);
  navigator.serviceWorker.addEventListener('message', handleWorkerMessage);
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
    const controller = navigator.serviceWorker.controller;
    if (!controller || controller.scriptURL.includes(IGNORE_WORKER_PATH)) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      const ourRegistrations = registrations.filter((r) => !r.scope.includes(IGNORE_WORKER_PATH));
      if (ourRegistrations.length) {
        if (DEBUG) {
          // eslint-disable-next-line no-console
          console.log('[SW] Hard reload detected, re-enabling Service Worker');
        }
        await Promise.all(ourRegistrations.map(async (registration) => {
          await capturePushDiagnosticSnapshot('workerUnregisterRequested', registration);
          return registration.unregister();
        }));
      }
    }

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
      subscribeToWorker();
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
    subscribeToWorker();
  });

  document.addEventListener('visibilitychange', () => {
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
