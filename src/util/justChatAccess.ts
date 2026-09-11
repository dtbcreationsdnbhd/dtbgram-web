import {
  APP_ENV,
  DEBUG,
  PLATFORM_API_KEY_WEBSITE,
  PLATFORM_API_ORIGIN,
  SESSION_LEGACY_USER_KEY,
} from '../config';
import { ACCOUNT_SLOT } from './multiaccount';
import { loadSlotSession } from './sessions';

export type JustChatAccessCheck = 'allowed' | 'denied' | 'unknown';

const GOOGLE_DENIED_URL = 'https://www.google.com';
const POLL_MS = 5_000;

const PLATFORM_API_PREFIX = (
  APP_ENV === 'development' || !PLATFORM_API_ORIGIN
)
  ? '/platform-api'
  : PLATFORM_API_ORIGIN.replace(/\/$/, '');

let pollTimer: number | undefined;
let started = false;
let inFlight: Promise<JustChatAccessCheck> | undefined;
let leaving = false;
let muteBeforeLeave: (() => Promise<void>) | undefined;

export function setJustChatMuteHandler(handler: () => Promise<void>) {
  muteBeforeLeave = handler;
}

export function leaveJustChatToGoogle() {
  if (leaving) {
    return;
  }
  leaving = true;

  void (async () => {
    try {
      if (muteBeforeLeave) {
        await muteBeforeLeave();
      }
    } catch (err) {
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.warn('[JustChatAccess] mute before leave failed', err);
      }
    } finally {
      window.location.replace(GOOGLE_DENIED_URL);
    }
  })();
}

export function getStoredTelegramUserId(currentUserId?: string): string | undefined {
  if (currentUserId) {
    return currentUserId;
  }

  const slotUserId = loadSlotSession(ACCOUNT_SLOT)?.userId;
  if (slotUserId) {
    return slotUserId;
  }

  try {
    const legacy = localStorage.getItem(SESSION_LEGACY_USER_KEY);
    if (!legacy) {
      return undefined;
    }
    const parsed = JSON.parse(legacy) as { id?: string };
    return parsed.id || undefined;
  } catch {
    return undefined;
  }
}

export async function reportJustChatSelfRestrict(currentUserId?: string): Promise<boolean> {
  const telegramUserId = getStoredTelegramUserId(currentUserId);
  if (!telegramUserId || !PLATFORM_API_KEY_WEBSITE) {
    return false;
  }

  const url = `${PLATFORM_API_PREFIX}/api/users/access`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': PLATFORM_API_KEY_WEBSITE,
      },
      body: JSON.stringify({ telegramUserId }),
      cache: 'no-store',
    });

    if (!response.ok) {
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.warn('[JustChatAccess] self-restrict failed', response.status);
      }
      return false;
    }
    return true;
  } catch (err) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[JustChatAccess] self-restrict error', err);
    }
    return false;
  }
}

export async function checkJustChatAccess(telegramUserId: string): Promise<JustChatAccessCheck> {
  const id = telegramUserId.trim();
  if (!id || !PLATFORM_API_KEY_WEBSITE) {
    return 'unknown';
  }

  const url = `${PLATFORM_API_PREFIX}/api/users/access?telegramUserId=${encodeURIComponent(id)}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'x-api-key': PLATFORM_API_KEY_WEBSITE,
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.warn('[JustChatAccess] check failed', response.status);
      }
      return 'unknown';
    }

    const body = await response.json() as { allowed?: boolean };
    if (body.allowed === false) {
      return 'denied';
    }
    if (body.allowed === true) {
      return 'allowed';
    }
    return 'unknown';
  } catch (err) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('[JustChatAccess] check error', err);
    }
    return 'unknown';
  }
}

export async function enforceJustChatAccess(currentUserId?: string): Promise<JustChatAccessCheck> {
  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    const telegramUserId = getStoredTelegramUserId(currentUserId);
    if (!telegramUserId) {
      return 'unknown' as const;
    }
    const result = await checkJustChatAccess(telegramUserId);
    if (result === 'denied') {
      leaveJustChatToGoogle();
    }
    return result;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = undefined;
  }
}

export function startJustChatAccessWatch(getCurrentUserId: () => string | undefined) {
  if (started) {
    return;
  }
  started = true;

  const run = () => {
    if (document.visibilityState === 'hidden') {
      return;
    }
    void enforceJustChatAccess(getCurrentUserId());
  };

  run();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      run();
    }
  });

  window.addEventListener('focus', run);
  window.addEventListener('pageshow', run);

  pollTimer = window.setInterval(() => {
    run();
  }, POLL_MS);

  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('[JustChatAccess] watching every', POLL_MS, 'ms');
  }
}
