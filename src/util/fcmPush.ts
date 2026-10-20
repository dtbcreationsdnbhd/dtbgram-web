import type { PushDiagnosticTrace } from './pushDiagnostics';

import {
  FCM_API_KEY, FCM_APP_ID, FCM_PROJECT_ID, WEB_PUSH_PUBLIC_KEY,
} from '../config';
import { recordPushDiagnosticStep } from './pushDiagnostics';

const INSTALLATIONS_URL = 'https://firebaseinstallations.googleapis.com/v1/projects';
const REGISTRATIONS_URL = 'https://fcmregistrations.googleapis.com/v1/projects';
const INSTALLATION_AUTH_VERSION = 'FIS_v2';
const INSTALLATION_SDK_VERSION = 'w:0.6.4';
const FID_BYTES = 17;
const FID_LENGTH = 22;
const FID_HEADER = 0b01110000;
const FID_HEADER_RANGE = 0b00010000;
const FCM_REQUEST_TIMEOUT_MS = 15000;

export const IS_FCM_PUSH_ENABLED = Boolean(FCM_PROJECT_ID && FCM_API_KEY && FCM_APP_ID && WEB_PUSH_PUBLIC_KEY);

// FCM signs its pushes with the project's Web Push certificate, so the Firebase project must hold
// the same VAPID key pair the subscription was created with
export async function requestFcmToken(deviceToken: string, trace: PushDiagnosticTrace) {
  let subscription: PushSubscriptionJSON;
  try {
    subscription = JSON.parse(deviceToken) as PushSubscriptionJSON;
  } catch {
    recordPushDiagnosticStep(trace, 'fcmSubscriptionInvalid');
    throw new Error('Invalid browser push subscription');
  }
  const { endpoint, keys } = subscription || {};
  if (typeof endpoint !== 'string' || !endpoint
    || typeof keys?.p256dh !== 'string' || !keys.p256dh || typeof keys.auth !== 'string' || !keys.auth) {
    recordPushDiagnosticStep(trace, 'fcmSubscriptionInvalid');
    throw new Error('Browser push subscription is missing endpoint or keys');
  }

  const installationAuthToken = await createInstallationAuthToken(trace);
  const response = await requestFirebaseJson(`${REGISTRATIONS_URL}/${FCM_PROJECT_ID}/registrations`, {
    method: 'POST',
    headers: {
      ...buildFirebaseHeaders(),
      'x-goog-firebase-installations-auth': `FIS ${installationAuthToken}`,
    },
    body: JSON.stringify({
      web: {
        endpoint,
        auth: keys.auth,
        p256dh: keys.p256dh,
        applicationPubKey: WEB_PUSH_PUBLIC_KEY,
      },
    }),
  }, trace, 'registration');
  if (!response || typeof response !== 'object' || !('token' in response)
    || typeof response.token !== 'string' || !response.token) {
    recordPushDiagnosticStep(trace, 'fcmTokenMissing');
    throw new Error('FCM registration returned no token');
  }
  return response.token;
}

async function createInstallationAuthToken(trace: PushDiagnosticTrace) {
  const response = await requestFirebaseJson(`${INSTALLATIONS_URL}/${FCM_PROJECT_ID}/installations`, {
    method: 'POST',
    headers: buildFirebaseHeaders(),
    body: JSON.stringify({
      fid: generateFid(),
      authVersion: INSTALLATION_AUTH_VERSION,
      appId: FCM_APP_ID,
      sdkVersion: INSTALLATION_SDK_VERSION,
    }),
  }, trace, 'installation');
  const authToken = response && typeof response === 'object' && 'authToken' in response
    ? response.authToken : undefined;
  if (!authToken || typeof authToken !== 'object' || !('token' in authToken)
    || typeof authToken.token !== 'string' || !authToken.token) {
    recordPushDiagnosticStep(trace, 'firebaseInstallationTokenMissing');
    throw new Error('Firebase installation returned no auth token');
  }
  return authToken.token;
}

async function requestFirebaseJson(
  url: string, options: RequestInit, trace: PushDiagnosticTrace, stage: 'installation' | 'registration',
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FCM_REQUEST_TIMEOUT_MS);
  const diagnosticStage = stage === 'installation' ? 'firebaseInstallation' : 'firebaseRegistration';
  let httpStatus: number | undefined;
  recordPushDiagnosticStep(trace, `${diagnosticStage}Requested`);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    httpStatus = response.status;
    recordPushDiagnosticStep(trace, `${diagnosticStage}Responded`, { httpStatus });
    if (!response.ok) {
      throw new Error('Firebase request failed');
    }
    return await response.json();
  } catch {
    const error = new Error(controller.signal.aborted
      ? `Firebase ${stage} timed out`
      : `Firebase ${stage} request failed${httpStatus === undefined ? '' : ` (HTTP ${httpStatus})`}`);
    error.name = controller.signal.aborted ? 'TimeoutError' : 'FirebaseRequestError';
    recordPushDiagnosticStep(trace, `${diagnosticStage}Failed`, {
      errorName: error.name,
      errorMessage: error.message,
      httpStatus,
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildFirebaseHeaders() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-goog-api-key': FCM_API_KEY,
  };
}

// Firebase installation IDs are 22 base64url characters whose first four bits are `0111`
function generateFid() {
  const bytes = crypto.getRandomValues(new Uint8Array(FID_BYTES));
  bytes[0] = FID_HEADER + (bytes[0] % FID_HEADER_RANGE);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .slice(0, FID_LENGTH);
}
