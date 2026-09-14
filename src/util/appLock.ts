/** localStorage flag set after a successful PIN unlock. Survives PWA task-kill. */
export const APP_LOCK_STORAGE_KEY = 'app_lock_passed';

/** Clears the unlock flag so the next JustChat load shows the PIN gate. */
export function clearAppLockPassed(): void {
  try {
    localStorage.removeItem(APP_LOCK_STORAGE_KEY);
  } catch {
    // ignore quota / private mode
  }
}

/**
 * If the URL asks for a lock (e.g. return from Blockerino Cancel), clear the unlock
 * flag and strip the query param so a refresh does not loop.
 */
export function consumeRequireLockQuery(): boolean {
  try {
    const url = new URL(window.location.href);
    const raw = url.searchParams.get('requireLock') ?? url.searchParams.get('requirePin');
    if (raw !== '1' && raw !== 'true') {
      return false;
    }
    clearAppLockPassed();
    url.searchParams.delete('requireLock');
    url.searchParams.delete('requirePin');
    const next = `${url.pathname}${url.search}${url.hash}` || '/';
    window.history.replaceState(null, '', next);
    return true;
  } catch {
    return false;
  }
}
