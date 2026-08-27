const INTERNAL_AUTH_API_PREFIX = '/internal-auth-api';

export type InternalQrChallenge = {
  challengeId: string;
  internalQrPayload: string;
  expiresAt: number;
  status?: string;
};

export async function publishOfficialLoginQr(officialToken: string) {
  try {
    const response = await fetch(`${INTERNAL_AUTH_API_PREFIX}/api/official-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        officialPayload: `tg://login?token=${officialToken}`,
      }),
    });
    if (!response.ok) return undefined;
    return await response.json() as InternalQrChallenge;
  } catch (err) {
    return undefined;
  }
}
