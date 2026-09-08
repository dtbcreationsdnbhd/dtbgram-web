import type { ApiSession } from '../../../../api/types';

import { SESSION_PLATFORM_LABEL } from '../../../../config';

export type SessionOrigin = 'internal' | 'official' | 'thirdParty';

const PLATFORM_LABEL_SUFFIX = ` (${SESSION_PLATFORM_LABEL})`;

export default function getSessionOrigin(session: ApiSession): SessionOrigin {
  if (session.appVersion.includes(PLATFORM_LABEL_SUFFIX)) {
    return 'internal';
  }

  return session.isOfficialApp ? 'official' : 'thirdParty';
}

// The label is rendered as a separate badge, so it is dropped from the version string itself
export function stripSessionPlatformLabel(appVersion: string) {
  return appVersion.replace(PLATFORM_LABEL_SUFFIX, '');
}
