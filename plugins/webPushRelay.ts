import { createPrivateKey, randomBytes, sign as signBytes } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Plugin } from 'vite';

type Options = {
  publicKey: string;
  privateKey: string;
  apiKey: string;
  publicOrigin: string;
};

type StoredSubscription = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

type StoredPush = {
  telegramUserId: string;
  subscription: StoredSubscription;
};

const SUBSCRIBE_PATH = '/platform-api/api/push/subscribe';
const WAKE_PATH_PREFIX = '/platform-api/telegram-push/';
const VAPID_JWT_TTL_SECONDS = 12 * 60 * 60;
const SECRET_BYTES = 16;

const secretByUserId = new Map<string, string>();
const pushBySecret = new Map<string, StoredPush>();

export default function buildWebPushRelayPlugin({
  publicKey,
  privateKey,
  apiKey,
  publicOrigin,
}: Options): Plugin {
  return {
    name: 'web-push-relay',
    configureServer(server) {
      if (!publicKey || !privateKey) {
        return;
      }

      server.middlewares.use(async (req, res, next) => {
        const path = req.url?.split('?')[0] || '';
        try {
          if (req.method === 'POST' && path === SUBSCRIBE_PATH) {
            await handleSubscribe(req, res, {
              apiKey,
              publicOrigin,
            });
            return;
          }

          if ((req.method === 'PUT' || req.method === 'POST') && path.startsWith(WAKE_PATH_PREFIX)) {
            await handleWake(req, res, path.slice(WAKE_PATH_PREFIX.length), publicKey, privateKey);
            return;
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[PUSH RELAY]', err);
          sendJson(res, 500, { success: false, message: 'Relay failed' });
          return;
        }

        next();
      });
    },
  };
}

async function handleSubscribe(
  req: IncomingMessage,
  res: ServerResponse,
  {
    apiKey,
    publicOrigin,
  }: Pick<Options, 'apiKey' | 'publicOrigin'>,
) {
  if (apiKey && req.headers['x-api-key'] !== apiKey) {
    sendJson(res, 401, { success: false, message: 'Unauthorized' });
    return;
  }

  const body = JSON.parse(await readBody(req) || '{}') as {
    telegramUserId?: string;
    subscription?: StoredSubscription;
  };
  const telegramUserId = body.telegramUserId?.trim();
  const subscription = body.subscription;
  if (!telegramUserId || !subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys.auth) {
    sendJson(res, 400, { success: false, message: 'Invalid subscription' });
    return;
  }

  let secret = secretByUserId.get(telegramUserId);
  if (!secret) {
    secret = randomBytes(SECRET_BYTES).toString('hex');
    secretByUserId.set(telegramUserId, secret);
  }
  pushBySecret.set(secret, { telegramUserId, subscription });

  const origin = publicOrigin || getRequestOrigin(req);
  sendJson(res, 200, {
    success: true,
    wakeUrl: `${origin}${WAKE_PATH_PREFIX}${secret}`,
  });
}

async function handleWake(
  req: IncomingMessage,
  res: ServerResponse,
  secret: string,
  publicKey: string,
  privateKey: string,
) {
  await readBody(req);
  const stored = pushBySecret.get(secret);
  if (!stored) {
    sendJson(res, 404, { success: false, message: 'Unknown push secret' });
    return;
  }

  await sendWebPush(stored.subscription, publicKey, privateKey);
  sendJson(res, 200, { success: true });
}

async function sendWebPush(
  subscription: StoredSubscription,
  publicKey: string,
  privateKey: string,
) {
  const audience = new URL(subscription.endpoint).origin;
  const jwt = createVapidJwt(audience, publicKey, privateKey);
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      Urgency: 'high',
      Authorization: `vapid t=${jwt}, k=${publicKey}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Web Push failed ${response.status} ${body}`);
  }
}

function createVapidJwt(audience: string, publicKey: string, privateKey: string) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: now + VAPID_JWT_TTL_SECONDS,
    sub: 'mailto:support@justchat.local',
  };
  const unsigned = `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(payload))}`;
  const key = createPrivateKey({
    key: buildVapidJwk(publicKey, privateKey),
    format: 'jwk',
  });
  const signature = signBytes('SHA256', Buffer.from(unsigned), {
    key,
    dsaEncoding: 'ieee-p1363',
  });

  return `${unsigned}.${signature.toString('base64url')}`;
}

function buildVapidJwk(publicKey: string, privateKey: string) {
  const publicBytes = fromBase64Url(publicKey);
  if (publicBytes.length !== 65 || publicBytes[0] !== 4) {
    throw new Error('Invalid VAPID public key');
  }

  return {
    kty: 'EC',
    crv: 'P-256',
    x: publicBytes.subarray(1, 33).toString('base64url'),
    y: publicBytes.subarray(33, 65).toString('base64url'),
    d: fromBase64Url(privateKey).toString('base64url'),
  };
}

function getRequestOrigin(req: IncomingMessage) {
  const host = req.headers.host;
  if (!host) {
    return 'http://localhost:1234';
  }
  const protocol = req.headers['x-forwarded-proto'] === 'https' || host.includes('ngrok')
    ? 'https'
    : 'http';
  return `${protocol}://${host}`;
}

function sendJson(res: ServerResponse, status: number, body: object) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function toBase64Url(value: string) {
  return Buffer.from(value).toString('base64url');
}

function fromBase64Url(value: string) {
  return Buffer.from(value, 'base64url');
}
