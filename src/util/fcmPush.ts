import {
  DEBUG, FCM_API_KEY, FCM_APP_ID, FCM_PROJECT_ID, WEB_PUSH_PUBLIC_KEY,
} from '../config';

const INSTALLATIONS_URL = 'https://firebaseinstallations.googleapis.com/v1/projects';
const REGISTRATIONS_URL = 'https://fcmregistrations.googleapis.com/v1/projects';
const INSTALLATION_AUTH_VERSION = 'FIS_v2';
const INSTALLATION_SDK_VERSION = 'w:0.6.4';
const FID_BYTES = 17;
const FID_LENGTH = 22;
const FID_HEADER = 0b01110000;
const FID_HEADER_RANGE = 0b00010000;

export const IS_FCM_PUSH_ENABLED = Boolean(FCM_PROJECT_ID && FCM_API_KEY && FCM_APP_ID && WEB_PUSH_PUBLIC_KEY);

// FCM signs its pushes with the project's Web Push certificate, so the Firebase project must hold
// the same VAPID key pair the subscription was created with
export async function requestFcmToken(deviceToken: string) {
  const { endpoint, keys } = JSON.parse(deviceToken) as PushSubscriptionJSON;
  if (!endpoint || !keys?.p256dh || !keys.auth) return undefined;

  try {
    const installationAuthToken = await createInstallationAuthToken();
    const response = await fetch(`${REGISTRATIONS_URL}/${FCM_PROJECT_ID}/registrations`, {
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
    });
    if (!response.ok) {
      throw new Error(`FCM registration failed: ${response.status} ${await response.text()}`);
    }

    const { token } = await response.json() as { token?: string };
    return token;
  } catch (err) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PUSH] Unable to get FCM token', err);
    }
    return undefined;
  }
}

async function createInstallationAuthToken() {
  const response = await fetch(`${INSTALLATIONS_URL}/${FCM_PROJECT_ID}/installations`, {
    method: 'POST',
    headers: buildFirebaseHeaders(),
    body: JSON.stringify({
      fid: generateFid(),
      authVersion: INSTALLATION_AUTH_VERSION,
      appId: FCM_APP_ID,
      sdkVersion: INSTALLATION_SDK_VERSION,
    }),
  });
  if (!response.ok) {
    throw new Error(`Firebase installation failed: ${response.status} ${await response.text()}`);
  }

  const { authToken } = await response.json() as { authToken?: { token?: string } };
  if (!authToken?.token) {
    throw new Error('Firebase installation returned no auth token');
  }
  return authToken.token;
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
