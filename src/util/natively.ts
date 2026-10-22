type NativelySdk = {
  injected: boolean;
  app_version: number;
  openConsole: NoneToVoidFunction;
};

type NativelyFirebaseNotifications = {
  firebase_request_permission: (callback: (response: { status?: unknown }) => void) => void;
  firebase_has_permission: (callback: (response: { status?: unknown }) => void) => void;
  firebase_get_token: (callback: (response: { token?: unknown }) => void) => void;
};

declare global {
  interface Window {
    $agent?: unknown;
    natively?: NativelySdk;
    NativelyFirebaseNotifications?: new () => NativelyFirebaseNotifications;
  }
}

const NATIVELY_SDK_URL = 'https://cdn.jsdelivr.net/npm/natively@2.26.0/natively-frontend.min.js';
const NATIVELY_READY_TIMEOUT_MS = 10000;
const NATIVELY_READY_POLL_MS = 100;
const MIN_CONSOLE_APP_VERSION = 22;

let sdkLoadPromise: Promise<void> | undefined;

// Loading before the page finishes lets the native app initialize the SDK bridge
if (checkIfNativelyApp()) {
  void loadNativelySdk().catch(() => undefined);
}

export function checkIfNativelyApp() {
  return /Natively\/(?:Android|iOS)/.test(navigator.userAgent) || typeof window.$agent !== 'undefined';
}

export async function openNativelyConsole() {
  if (!checkIfNativelyApp()) throw new Error('Natively console requires the native app');
  const sdk = await waitForNativelySdk();
  if (sdk.app_version < MIN_CONSOLE_APP_VERSION) {
    throw new Error('Rebuild the Natively app to enable its console');
  }
  sdk.openConsole();
}

export async function getNativelyPushState() {
  if (!checkIfNativelyApp()) throw new Error('Native push requires the Natively app');
  await waitForNativelySdk();
  const Notifications = window.NativelyFirebaseNotifications;
  if (!Notifications) throw new Error('Natively Firebase notifications are unavailable');
  const notifications = new Notifications();
  const permission = await runNativelyCallback<{ status?: unknown }>((callback) => {
    notifications.firebase_has_permission(callback);
  });
  if (permission.status !== true) return { hasPermission: false, token: undefined };

  const response = await runNativelyCallback<{ token?: unknown }>((callback) => {
    notifications.firebase_get_token(callback);
  });
  return {
    hasPermission: true,
    token: typeof response.token === 'string' && response.token ? response.token : undefined,
  };
}

export async function requestNativelyPushPermission() {
  if (!checkIfNativelyApp()) return false;
  await waitForNativelySdk();
  const Notifications = window.NativelyFirebaseNotifications;
  if (!Notifications) throw new Error('Natively Firebase notifications are unavailable');
  const notifications = new Notifications();
  const response = await runNativelyCallback<{ status?: unknown }>((callback) => {
    notifications.firebase_request_permission(callback);
  });
  return response.status === true;
}

function runNativelyCallback<T>(start: (callback: (response: T) => void) => void) {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error('Natively Firebase request timed out'));
    }, NATIVELY_READY_TIMEOUT_MS);
    try {
      start((response) => {
        window.clearTimeout(timeout);
        resolve(response);
      });
    } catch {
      window.clearTimeout(timeout);
      reject(new Error('Natively Firebase request failed'));
    }
  });
}

function waitForNativelySdk() {
  return new Promise<NativelySdk>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      finish(new Error('Natively SDK initialization timed out'));
    }, NATIVELY_READY_TIMEOUT_MS);
    const interval = window.setInterval(checkIfReady, NATIVELY_READY_POLL_MS);

    function checkIfReady() {
      const sdk = window.natively;
      if (sdk?.injected && sdk.app_version > 0 && typeof sdk.openConsole === 'function') {
        finish(undefined, sdk);
      }
    }

    function finish(err?: unknown, sdk?: NativelySdk) {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
      if (err) reject(err);
      else resolve(sdk!);
    }

    void loadNativelySdk().then(checkIfReady, finish);
  });
}

function loadNativelySdk() {
  if (typeof window.natively?.openConsole === 'function') return Promise.resolve();
  // Sharing a pending script avoids replacing the native bridge when a slow load finishes
  if (sdkLoadPromise) return sdkLoadPromise;

  sdkLoadPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = NATIVELY_SDK_URL;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.addEventListener('load', () => {
      if (typeof window.natively?.openConsole === 'function') {
        resolve();
      } else {
        script.remove();
        reject(new Error('Natively SDK does not provide a console'));
      }
    }, { once: true });
    script.addEventListener('error', () => {
      script.remove();
      reject(new Error('Natively SDK could not be loaded'));
    }, { once: true });
    document.head.appendChild(script);
  }).catch((err: unknown) => {
    sdkLoadPromise = undefined;
    throw err;
  });

  return sdkLoadPromise;
}
