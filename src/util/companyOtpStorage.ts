import { ACCOUNT_SLOT } from './multiaccount';

const STORAGE_PREFIX = 'tt-company-otp';

function buildKey(kind: 'verified' | 'pending', userId?: string) {
  const slot = ACCOUNT_SLOT || 1;
  if (kind === 'pending') {
    return `${STORAGE_PREFIX}-pending-${slot}`;
  }

  return `${STORAGE_PREFIX}-verified-${slot}-${userId}`;
}

export function isCompanyOtpVerified(userId: string) {
  try {
    return localStorage.getItem(buildKey('verified', userId)) === '1';
  } catch (err) {
    return false;
  }
}

export function setCompanyOtpVerified(userId: string) {
  try {
    localStorage.setItem(buildKey('verified', userId), '1');
    localStorage.removeItem(buildKey('pending'));
  } catch (err) {
    // Ignore storage failures
  }
}

export function clearCompanyOtpVerified(userId?: string) {
  try {
    if (userId) {
      localStorage.removeItem(buildKey('verified', userId));
    }
    localStorage.removeItem(buildKey('pending'));
  } catch (err) {
    // Ignore storage failures
  }
}

export function setCompanyOtpPendingUserId(userId: string) {
  try {
    localStorage.setItem(buildKey('pending'), userId);
  } catch (err) {
    // Ignore storage failures
  }
}

export function getCompanyOtpPendingUserId() {
  try {
    return localStorage.getItem(buildKey('pending')) || undefined;
  } catch (err) {
    return undefined;
  }
}

export function clearCompanyOtpPendingUserId() {
  try {
    localStorage.removeItem(buildKey('pending'));
  } catch (err) {
    // Ignore storage failures
  }
}
