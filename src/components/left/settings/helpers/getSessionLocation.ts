import type { ApiSession } from '../../../../api/types';

export default function getSessionLocation(session: ApiSession) {
  return [session.region, session.country].filter(Boolean).join(', ');
}
