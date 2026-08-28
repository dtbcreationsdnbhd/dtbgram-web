import { APP_ENV, DEBUG, PLATFORM_API_KEY_WEBSITE, PLATFORM_API_ORIGIN } from '../config';

const PLATFORM_API_PREFIX = (
  APP_ENV === 'development' || !PLATFORM_API_ORIGIN
)
  ? '/platform-api'
  : PLATFORM_API_ORIGIN;

const syncedUserIds = new Set<string>();

export type PlatformCreateUserPayload = {
  telegramUserId: string;
  username: string;
  phoneNumber: string;
};

export function resetPlatformUserSync(userId?: string) {
  if (userId) {
    syncedUserIds.delete(userId);
    return;
  }

  syncedUserIds.clear();
}

export async function createPlatformUser(payload: PlatformCreateUserPayload) {
  if (!PLATFORM_API_KEY_WEBSITE) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PlatformAPI] Skip create: missing PLATFORM_API_KEY_WEBSITE');
    }
    return;
  }

  if (!payload.telegramUserId || !payload.username || !payload.phoneNumber) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PlatformAPI] Skip create: incomplete payload', payload);
    }
    return;
  }

  if (syncedUserIds.has(payload.telegramUserId)) {
    return;
  }

  syncedUserIds.add(payload.telegramUserId);

  const url = `${PLATFORM_API_PREFIX}/api/users/create`;

  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('[PlatformAPI] Creating user', url, payload);
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': PLATFORM_API_KEY_WEBSITE,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      syncedUserIds.delete(payload.telegramUserId);
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.warn('[PlatformAPI] Create user failed', response.status, await response.text());
      }
      return;
    }

    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log('[PlatformAPI] User saved', payload.telegramUserId);
    }
  } catch (err) {
    syncedUserIds.delete(payload.telegramUserId);
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PlatformAPI] Create user request error', err);
    }
  }
}

export function formatPlatformPhoneNumber(phoneNumber?: string) {
  if (!phoneNumber) {
    return undefined;
  }

  const trimmed = phoneNumber.replace(/[\s-]/g, '').trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith('+')) {
    return trimmed;
  }

  return `+${trimmed}`;
}
