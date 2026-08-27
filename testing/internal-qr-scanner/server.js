import http from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT) || 8080;
const CHALLENGE_DURATION_MS = 30 * 60 * 1000;
const INTERNAL_PREFIX = 'internal-login://challenge/';
const OFFICIAL_PREFIX = 'tg://login?token=';

const challenges = new Map();
let currentChallengeId;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'OPTIONS') {
      sendCors(response, 204);
      return;
    }

    const requestUrl = new URL(request.url, getRequestOrigin(request));
    const body = await readJsonBody(request);

    if (request.method === 'POST' && requestUrl.pathname === '/api/official-token') {
      sendJson(response, 200, publishOfficialToken(body));
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/scan') {
      sendJson(response, 200, scanInternalQr(body));
      return;
    }

    throw new ApiError(404, 'NOT_FOUND', 'API endpoint not found.');
  } catch (error) {
    if (error instanceof ApiError) {
      sendJson(response, error.status, { code: error.code, message: error.message });
      return;
    }
    console.error(error);
    sendJson(response, 500, { code: 'SERVER_ERROR', message: 'Internal QR login server error.' });
  }
});

server.listen(PORT, () => {
  console.log(`Internal QR login API: http://localhost:${PORT}/api/official-token`);
});

function publishOfficialToken(body) {
  const officialToken = extractOfficialToken(body.officialPayload);
  const now = Date.now();
  const existing = currentChallengeId ? challenges.get(currentChallengeId) : undefined;

  if (existing && existing.status === 'issued' && existing.expiresAt > now) {
    existing.officialToken = officialToken;
    existing.expiresAt = now + CHALLENGE_DURATION_MS;
    return serializeChallenge(existing);
  }

  const challengeId = randomBytes(16).toString('hex');
  const challenge = {
    challengeId,
    officialToken,
    expiresAt: now + CHALLENGE_DURATION_MS,
    status: 'issued',
  };
  challenges.set(challengeId, challenge);
  currentChallengeId = challengeId;
  return serializeChallenge(challenge);
}

function serializeChallenge(challenge) {
  return {
    challengeId: challenge.challengeId,
    expiresAt: challenge.expiresAt,
    status: challenge.status,
    internalQrPayload: `${INTERNAL_PREFIX}${challenge.challengeId}`,
  };
}

function scanInternalQr(body) {
  const payload = String(body.qrPayload || '').trim();
  if (payload.startsWith(OFFICIAL_PREFIX)) {
    throw new ApiError(400, 'QR_NOT_INTERNAL', 'Scan the internal QR, not the official Telegram QR.');
  }
  if (!payload.startsWith(INTERNAL_PREFIX)) {
    throw new ApiError(400, 'QR_NOT_INTERNAL', 'Only internal-login QR codes are accepted.');
  }

  const challengeId = payload.slice(INTERNAL_PREFIX.length).split(/[?#]/)[0];
  const challenge = requireChallenge(challengeId);
  expireIfNeeded(challenge);
  if (challenge.status === 'expired') {
    throw new ApiError(410, 'QR_EXPIRED', 'This internal QR expired.');
  }
  if (challenge.status === 'scanned') {
    throw new ApiError(409, 'QR_ALREADY_USED', 'This internal QR was already used.');
  }

  challenge.status = 'scanned';
  return {
    status: 'scanned',
    officialTelegramQrPayload: `${OFFICIAL_PREFIX}${challenge.officialToken}`,
  };
}

function requireChallenge(challengeId) {
  const challenge = challenges.get(challengeId);
  if (!challenge) {
    throw new ApiError(404, 'QR_UNKNOWN', 'Internal login challenge was not found.');
  }
  return challenge;
}

function expireIfNeeded(challenge) {
  if (challenge.status === 'issued' && challenge.expiresAt <= Date.now()) {
    challenge.status = 'expired';
  }
}

function extractOfficialToken(value) {
  const payload = String(value || '').trim();
  if (!payload) {
    throw new ApiError(400, 'TOKEN_REQUIRED', 'officialPayload is required.');
  }
  if (payload.startsWith(OFFICIAL_PREFIX)) {
    const token = payload.slice(OFFICIAL_PREFIX.length).trim();
    if (!token) {
      throw new ApiError(400, 'TOKEN_REQUIRED', 'The official login token is empty.');
    }
    return token;
  }
  return payload;
}

async function readJsonBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
    return {};
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new ApiError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
  }
}

function getRequestOrigin(request) {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : (forwardedProto || 'http');
  return `${protocol}://${request.headers.host}`;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, ngrok-skip-browser-warning',
  };
}

function sendCors(response, status) {
  response.writeHead(status, corsHeaders());
  response.end();
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(),
  });
  response.end(JSON.stringify(body));
}
