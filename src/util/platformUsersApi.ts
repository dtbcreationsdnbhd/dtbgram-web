import { APP_ENV, DEBUG, PLATFORM_API_KEY_WEBSITE, PLATFORM_API_ORIGIN } from '../config';

const PLATFORM_API_PREFIX = (
  APP_ENV === 'development' || !PLATFORM_API_ORIGIN
)
  ? '/platform-api'
  : PLATFORM_API_ORIGIN;

const lastSyncedPayloadByUserId = new Map<string, string>();

export type PlatformUserPayload = {
  telegramUserId: string;
  username: string;
  phoneNumber: string;
};

export function resetPlatformUserSync(userId?: string) {
  if (userId) {
    lastSyncedPayloadByUserId.delete(userId);
    return;
  }

  lastSyncedPayloadByUserId.clear();
}

export async function createPlatformUser(payload: PlatformUserPayload) {
  return requestPlatformUser('/api/users/create', payload, 'create');
}

export async function updatePlatformUser(payload: PlatformUserPayload) {
  return requestPlatformUser('/api/users/update', payload, 'update');
}

export async function syncPlatformUser(payload: PlatformUserPayload) {
  if (!isValidPlatformUserPayload(payload)) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PlatformAPI] Skip sync: incomplete payload', payload);
    }
    return;
  }

  const payloadKey = buildPayloadKey(payload);
  const previousKey = lastSyncedPayloadByUserId.get(payload.telegramUserId);

  if (!previousKey) {
    const didCreate = await createPlatformUser(payload);
    if (!didCreate) {
      return;
    }
    lastSyncedPayloadByUserId.set(payload.telegramUserId, payloadKey);
    return;
  }

  if (previousKey === payloadKey) {
    return;
  }

  const didUpdate = await updatePlatformUser(payload);
  if (didUpdate) {
    lastSyncedPayloadByUserId.set(payload.telegramUserId, payloadKey);
    return;
  }

  // User may have been deleted server-side; recreate.
  const didCreate = await createPlatformUser(payload);
  if (didCreate) {
    lastSyncedPayloadByUserId.set(payload.telegramUserId, payloadKey);
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

async function requestPlatformUser(
  path: '/api/users/create' | '/api/users/update',
  payload: PlatformUserPayload,
  action: 'create' | 'update',
) {
  if (!PLATFORM_API_KEY_WEBSITE) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn(`[PlatformAPI] Skip ${action}: missing PLATFORM_API_KEY_WEBSITE`);
    }
    return false;
  }

  if (!isValidPlatformUserPayload(payload)) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn(`[PlatformAPI] Skip ${action}: incomplete payload`, payload);
    }
    return false;
  }

  const url = `${PLATFORM_API_PREFIX}${path}`;

  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log(`[PlatformAPI] ${action} user`, url, payload);
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
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.warn(`[PlatformAPI] ${action} user failed`, response.status, await response.text());
      }
      return false;
    }

    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`[PlatformAPI] User ${action}d`, payload.telegramUserId);
    }
    return true;
  } catch (err) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn(`[PlatformAPI] ${action} user request error`, err);
    }
    return false;
  }
}

function isValidPlatformUserPayload(payload: PlatformUserPayload) {
  return Boolean(payload.telegramUserId && payload.username && payload.phoneNumber);
}

function buildPayloadKey(payload: PlatformUserPayload) {
  return `${payload.telegramUserId}|${payload.username}|${payload.phoneNumber}`;
}
