import { ROSTER_SESSION_USER_ID } from '../config';
import { createSignal } from './signals';

const STORAGE_KEY = 'dtbgram_employee_verified_ids';
const ROSTER_HOURS_UTC8 = [10, 11, 12, 13, 15, 16] as const;
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

let cached = new Set<string>();
const [getEmployeeVerifiedRevision, setEmployeeVerifiedRevision] = createSignal(0);

export { getEmployeeVerifiedRevision };

export function parseVerifiedIds(json: unknown): string[] {
  const ids = extractVerifiedIds(json);
  if (!Array.isArray(ids)) {
    return [];
  }

  return ids.map((id) => String(id).trim()).filter(Boolean);
}

function extractVerifiedIds(json: unknown): unknown {
  if (!json || typeof json !== 'object') {
    return undefined;
  }

  if ('ids' in json) {
    return (json as { ids: unknown }).ids;
  }

  const nested = (json as {
    data?: { listVerifiedUserIds?: { ids?: unknown } };
  }).data?.listVerifiedUserIds?.ids;

  return nested;
}

export function saveCachedIds(ids: string[]) {
  cached = new Set(ids);
  setEmployeeVerifiedRevision(getEmployeeVerifiedRevision() + 1);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Ignore quota
  }
}

export function loadCachedIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const ids = parseVerifiedIds({ ids: JSON.parse(raw) });
      cached = new Set(ids);
      setEmployeeVerifiedRevision(getEmployeeVerifiedRevision() + 1);
      return ids;
    }
  } catch {
    // Keep memory
  }

  return [...cached];
}

export function replaceVerifiedIds(ids: string[]) {
  saveCachedIds(ids);
}

export function isEmployeeVerified(peerId?: string): boolean {
  if (!peerId) {
    return false;
  }

  return peerId === ROSTER_SESSION_USER_ID || cached.has(peerId);
}

export function shouldShowEmployeeVerified(viewerId?: string, peerId?: string): boolean {
  if (!viewerId || !peerId) {
    return false;
  }

  return isEmployeeVerified(viewerId) && isEmployeeVerified(peerId);
}

export function millisUntilNextRosterSlot(nowMs = Date.now()): number {
  const utc8Now = new Date(nowMs + UTC8_OFFSET_MS);
  const year = utc8Now.getUTCFullYear();
  const month = utc8Now.getUTCMonth();
  const day = utc8Now.getUTCDate();

  for (const hour of ROSTER_HOURS_UTC8) {
    const slotUtcMs = Date.UTC(year, month, day, hour, 0, 0, 0) - UTC8_OFFSET_MS;
    if (slotUtcMs > nowMs) {
      return slotUtcMs - nowMs;
    }
  }

  const nextTenUtcMs = Date.UTC(year, month, day + 1, 10, 0, 0, 0) - UTC8_OFFSET_MS;
  return nextTenUtcMs - nowMs;
}

loadCachedIds();
