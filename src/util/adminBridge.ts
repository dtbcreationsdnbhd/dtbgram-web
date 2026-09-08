import type { ApiSession } from '../api/types';

import { callApi } from '../api/gramjs';

export type AdminActiveSessionsSnapshot = {
  sessions: ApiSession[];
  ttlDays?: number;
};

async function fetchActiveSessions(): Promise<AdminActiveSessionsSnapshot> {
  const result = await callApi('fetchAuthorizations');
  if (!result) {
    throw new Error('Telegram did not return active sessions');
  }

  return {
    sessions: Object.values(result.authorizations).sort((left, right) => {
      if (left.isCurrent !== right.isCurrent) {
        return left.isCurrent ? -1 : 1;
      }
      return right.dateActive - left.dateActive;
    }),
    ttlDays: result.ttlDays,
  };
}

declare global {
  interface Window {
    __DTBGRAM_ADMIN__?: {
      fetchActiveSessions: () => Promise<AdminActiveSessionsSnapshot>;
      terminateActiveSessions: (
        hashes: string[],
      ) => Promise<AdminActiveSessionsSnapshot>;
    };
  }
}

if (typeof window !== 'undefined') {
  window.__DTBGRAM_ADMIN__ = {
    fetchActiveSessions,
    async terminateActiveSessions(hashes) {
      const snapshot = await fetchActiveSessions();
      const requestedHashes = new Set(hashes);
      const safeHashes = snapshot.sessions
        .filter((session) => !session.isCurrent && requestedHashes.has(session.hash))
        .map((session) => session.hash);

      for (const hash of safeHashes) {
        const wasTerminated = await callApi('terminateAuthorizationForAdmin', hash);
        if (!wasTerminated) {
          throw new Error(`Telegram could not terminate session ${hash}`);
        }
      }

      return fetchActiveSessions();
    },
  };
}
