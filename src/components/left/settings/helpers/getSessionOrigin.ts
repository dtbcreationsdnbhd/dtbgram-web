import type { ApiSession } from '../../../../api/types';

import { SESSION_LABEL_PREFIX } from '../../../../config';

export type SessionOrigin = 'internal' | 'official' | 'thirdParty';

const INTERNAL_LABEL_REGEX = new RegExp(`\\s*\\(${SESSION_LABEL_PREFIX}: ([^)]+)\\)`);

export default function getSessionOrigin(session: ApiSession): SessionOrigin {
  if (getSessionInternalClient(session)) {
    return 'internal';
  }

  return session.isOfficialApp ? 'official' : 'thirdParty';
}

// Client that created the authorization, e.g. `Web` or `Android`, or `undefined` for non-internal sessions
export function getSessionInternalClient(session: ApiSession) {
  return session.appVersion.match(INTERNAL_LABEL_REGEX)?.[1];
}

// The label is rendered as a separate badge, so it is dropped from the version string itself
export function stripSessionPlatformLabel(appVersion: string) {
  return appVersion.replace(INTERNAL_LABEL_REGEX, '');
}
