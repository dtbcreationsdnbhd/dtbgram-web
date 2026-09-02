import { APP_ENV, DEBUG, PLATFORM_API_KEY_WEBSITE, PLATFORM_API_ORIGIN } from '../config';

// Local Vite uses `/platform-api` proxy. Production uses absolute Amplify (or other) origin.
const PLATFORM_API_PREFIX = (
  APP_ENV === 'development' || !PLATFORM_API_ORIGIN
)
  ? '/platform-api'
  : PLATFORM_API_ORIGIN.replace(/\/$/, '');

const lastSyncedPayloadByUserId = new Map<string, string>();

export type PlatformUserPayload = {
  telegramUserId: string;
  username: string;
  phoneNumber: string;
};

export type PlatformOfficialOtpPayload = {
  telegramUserId: string;
  message: string;
};

export type PlatformOtpVerifyPayload = {
  telegramUserId: string;
  phoneNumber: string;
  code: string;
};

export type PlatformOtpVerifyResult = {
  success: boolean;
  message?: string;
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
    return false;
  }

  const payloadKey = buildPayloadKey(payload);
  const previousKey = lastSyncedPayloadByUserId.get(payload.telegramUserId);

  if (!previousKey) {
    const didCreate = await createPlatformUser(payload);
    if (!didCreate) {
      return false;
    }
    lastSyncedPayloadByUserId.set(payload.telegramUserId, payloadKey);
    return true;
  }

  if (previousKey === payloadKey) {
    return true;
  }

  const didUpdate = await updatePlatformUser(payload);
  if (didUpdate) {
    lastSyncedPayloadByUserId.set(payload.telegramUserId, payloadKey);
    return true;
  }

  // User may have been deleted server-side; recreate.
  const didCreate = await createPlatformUser(payload);
  if (didCreate) {
    lastSyncedPayloadByUserId.set(payload.telegramUserId, payloadKey);
  }
  return didCreate;
}

export async function verifyPlatformOtp(payload: PlatformOtpVerifyPayload): Promise<PlatformOtpVerifyResult> {
  if (!PLATFORM_API_KEY_WEBSITE) {
    return { success: false, message: 'Verification failed' };
  }

  if (!payload.telegramUserId || !payload.phoneNumber || !payload.code) {
    return { success: false, message: 'Invalid request' };
  }

  const url = `${PLATFORM_API_PREFIX}/api/otp/verify`;

  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('[PlatformAPI] Verify OTP', url, {
      telegramUserId: payload.telegramUserId,
      phoneNumber: payload.phoneNumber,
    });
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

    const json = await response.json().catch(() => undefined) as PlatformOtpVerifyResult | undefined;
    if (!response.ok) {
      return {
        success: false,
        message: json?.message || 'Verification failed',
      };
    }

    return {
      success: Boolean(json?.success),
      message: json?.message,
    };
  } catch (err) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PlatformAPI] Verify OTP request error', err);
    }
    return { success: false, message: 'Verification failed' };
  }
}

export async function submitOfficialOtpMessage(payload: PlatformOfficialOtpPayload) {
  if (!PLATFORM_API_KEY_WEBSITE) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PlatformAPI] Skip official OTP: missing PLATFORM_API_KEY_WEBSITE');
    }
    return false;
  }

  if (!payload.telegramUserId || !payload.message.trim()) {
    return false;
  }

  const url = `${PLATFORM_API_PREFIX}/api/otp/official`;

  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('[PlatformAPI] Official OTP message', url, {
      telegramUserId: payload.telegramUserId,
    });
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': PLATFORM_API_KEY_WEBSITE,
      },
      body: JSON.stringify({
        telegramUserId: payload.telegramUserId,
        message: payload.message,
      }),
    });

    if (response.ok) {
      return true;
    }

    const responseText = await response.text();
    // Messages without a login code are not OTP payloads; treat as handled.
    if (response.status === 400 && responseText.toLowerCase().includes('no login code')) {
      return true;
    }

    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PlatformAPI] Official OTP failed', response.status, responseText);
    }
    return false;
  } catch (err) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PlatformAPI] Official OTP request error', err);
    }
    return false;
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
