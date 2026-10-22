import { sign } from 'node:crypto';

import type { FirebaseCredentials, NativeNotification } from './types.ts';

import { isRecord } from './config.ts';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIREBASE_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const REQUEST_TIMEOUT_MS = 15000;
const SECONDS_TO_MS = 1000;
const TOKEN_LIFETIME_SECONDS = 3600;
const TOKEN_MARGIN_MS = 60 * SECONDS_TO_MS;
const MAX_RESPONSE_BYTES = 16 * 1024;

export function createFirebaseSender(credentials: FirebaseCredentials) {
  let accessToken: string | undefined;
  let expiresAt = 0;

  return async function sendNotification(
    nativeToken: string, notification: NativeNotification, checkIfEnabled: () => Promise<void> | void,
  ) {
    if (!accessToken || Date.now() >= expiresAt - TOKEN_MARGIN_MS) {
      const issuedAt = Math.floor(Date.now() / SECONDS_TO_MS);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const claims = Buffer.from(JSON.stringify({
        iss: credentials.clientEmail,
        scope: FIREBASE_SCOPE,
        aud: GOOGLE_TOKEN_URL,
        iat: issuedAt,
        exp: issuedAt + TOKEN_LIFETIME_SECONDS,
      })).toString('base64url');
      const unsigned = `${header}.${claims}`;
      const signature = sign('RSA-SHA256', Buffer.from(unsigned), credentials.privateKey).toString('base64url');
      const response = await requestJson(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: `${unsigned}.${signature}`,
        }).toString(),
      });
      if (!isRecord(response) || typeof response.access_token !== 'string' || !response.access_token
        || typeof response.expires_in !== 'number' || !Number.isFinite(response.expires_in)
        || response.expires_in <= 0) throw new Error('Invalid Google OAuth response');
      accessToken = response.access_token;
      expiresAt = Date.now() + Math.min(response.expires_in, TOKEN_LIFETIME_SECONDS) * SECONDS_TO_MS;
    }
    await checkIfEnabled();
    const response = await requestJson(
      `https://fcm.googleapis.com/v1/projects/${credentials.projectId}/messages:send`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          message: {
            token: nativeToken,
            notification: { title: notification.title, body: notification.body },
            android: {
              priority: 'HIGH',
              ttl: '300s',
              notification: {
                tag: notification.tag,
                notification_count: notification.unreadCount,
                visibility: 'PRIVATE',
                defaultSound: notification.isSilent ? undefined : true,
              },
            },
            data: { url: notification.url },
          },
        }),
      },
    );
    if (!isRecord(response) || typeof response.name !== 'string') {
      throw new Error('Invalid Firebase send acknowledgement');
    }
  };
}

async function requestJson(url: string, options: RequestInit): Promise<unknown> {
  let response: Response;
  let body: Buffer;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    body = await readResponseBody(response);
  } catch {
    throw new Error('Firebase request failed or returned an invalid response');
  }
  if (!response.ok) throw new Error(`Firebase request failed (HTTP ${response.status})`);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('Invalid Firebase JSON response');
  }
}

async function readResponseBody(response: Response) {
  if (!response.body) throw new Error('Missing Firebase response');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Oversized Firebase response');
      }
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}
