import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';

import type { ProbeConfig } from './types.ts';

import { hashValue, prepareProbe, readFirebaseCredentials, readProbe } from './config.ts';
import { createFirebaseSender } from './firebase.ts';
import { formatPush } from './format.ts';
import { materializeRuntimeSecrets } from './runtimeSecrets.ts';
import { decryptWebPush, MAX_PUSH_BYTES } from './webPush.ts';

const REQUEST_TIMEOUT_MS = 10000;
const HEADERS_TIMEOUT_MS = 5000;
const MAX_HEADERS_BYTES = 8192;
const MAX_HEADERS_COUNT = 32;
const DEFAULT_PORT = 8787;
const MAX_PORT = 65535;
const MAX_DEDUP_ENTRIES = 1024;
const DEDUP_LIFETIME_MS = 10 * 60 * 1000;
const DEFAULT_HOST = '127.0.0.1';
const ALLOWED_HOSTS = new Set([DEFAULT_HOST, '0.0.0.0']);
const MAX_SMOKE_TITLE_CHARACTERS = 80;
const MAX_SMOKE_BODY_CHARACTERS = 400;

try {
  await runCommand();
} catch (err) {
  const message = err instanceof Error ? err.message : 'Native push probe failed';
  // Startup errors contain configuration descriptions, never configuration contents
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function runCommand() {
  let [command, ...args] = process.argv.slice(2);
  if (command === 'serve-env' && args.length === 0) {
    if (process.env.ENABLE_NATIVE_PUSH_PROBE !== '1') throw new Error('Native push probe is not enabled');
    args = await materializeRuntimeSecrets();
    command = 'serve';
  }
  if (command === 'prepare' && args.length === 4) {
    await prepareProbe(args[0], args[1], args[2], args[3]);
    writeDiagnostic({ outcome: 'prepared', lifetimeMinutes: 60 });
    return;
  }
  if ((command === 'send' || command === 'serve') && args.length === 2) {
    const [probePath, credentialsPath] = args;
    const config = await readProbe(probePath);
    if (config.disabled) throw new Error('Probe sending is disabled');
    const credentials = await readFirebaseCredentials(credentialsPath);
    const sendNotification = createFirebaseSender(credentials);
    const checkIfEnabled = async () => {
      const current = await readProbe(probePath);
      if (current.disabled || hashValue(JSON.stringify(current)) !== hashValue(JSON.stringify(config))) {
        throw new Error('Probe sending is disabled or configuration changed; restart after review');
      }
    };
    if (command === 'send') {
      if (!config.context.hasWebNotifications) throw new Error('Notifications are disabled in the exported context');
      await sendNotification(config.nativeToken, {
        title: Array.from(config.appName).slice(0, MAX_SMOKE_TITLE_CHARACTERS).join(''),
        body: Array.from(config.context.messageText).slice(0, MAX_SMOKE_BODY_CHARACTERS).join(''),
        url: config.baseUrl,
        tag: 'native-push-probe-smoke',
        isSilent: false,
      }, checkIfEnabled);
      writeDiagnostic({ outcome: 'smokeAcceptedByFirebase' });
      return;
    }
    if (process.env.ENABLE_NATIVE_PUSH_PROBE !== '1') {
      throw new Error('Set ENABLE_NATIVE_PUSH_PROBE=1 to start the temporary receiver');
    }
    await startServer(config, checkIfEnabled, sendNotification);
    return;
  }
  throw new Error('Usage: main.ts prepare SETUP_JSON PROBE_JSON ENROLLMENT_JSON HTTPS_PUBLIC_ORIGIN'
    + ' | send PROBE_JSON FIREBASE_SERVICE_ACCOUNT_JSON | serve PROBE_JSON FIREBASE_SERVICE_ACCOUNT_JSON | serve-env');
}

async function startServer(
  config: ProbeConfig,
  checkIfEnabled: () => Promise<void>,
  sendNotification: ReturnType<typeof createFirebaseSender>,
) {
  const host = process.env.NATIVE_PUSH_HOST || DEFAULT_HOST;
  const port = Number(process.env.NATIVE_PUSH_PORT || DEFAULT_PORT);
  if (!ALLOWED_HOSTS.has(host) || !Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error('Invalid probe listening address');
  }
  const expectedPath = new URL(config.subscription.endpoint).pathname;
  const seen = new Map<string, number>();
  let isBusy = false;
  let hasStopped = false;
  const server = createServer({ maxHeaderSize: MAX_HEADERS_BYTES }, (request, response) => {
    void handleRequest(request, response).catch(() => {
      writeDiagnostic({ outcome: 'requestFailed' });
      respond(response, 503);
    });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.maxHeadersCount = MAX_HEADERS_COUNT;
  const expiryTimer = setTimeout(() => {
    hasStopped = true;
    server.close();
    server.closeAllConnections();
    writeDiagnostic({ outcome: 'expired' });
  }, config.expiresAt - Date.now());
  function stopServer() {
    hasStopped = true;
    clearTimeout(expiryTimer);
    server.close();
    server.closeAllConnections();
  }
  process.once('SIGTERM', stopServer);
  process.once('SIGINT', stopServer);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      writeDiagnostic({ outcome: 'listening', host, port, expiresAt: config.expiresAt });
      resolve();
    });
  });

  async function checkIfServerEnabled() {
    if (hasStopped) throw new Error('Probe server has stopped');
    await checkIfEnabled();
    if (hasStopped) throw new Error('Probe server has stopped');
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse) {
    if (request.url === '/health' && request.method === 'GET') {
      try {
        await checkIfServerEnabled();
        respond(response, 200);
      } catch {
        respond(response, 503);
      }
      return;
    }
    if (!checkIfPathMatches(request.url || '', expectedPath)) {
      respond(response, 404);
      return;
    }
    if (request.method !== 'POST') {
      writeDiagnostic({ outcome: 'unsupportedMethod', method: request.method });
      respond(response, 405);
      return;
    }
    const encoding = request.headers['content-encoding'];
    if (encoding !== 'aes128gcm' && encoding !== 'aesgcm') {
      writeDiagnostic({ outcome: 'unsupportedEncoding', hasEncoding: encoding !== undefined });
      respond(response, 415);
      return;
    }
    if (isBusy) {
      respond(response, 503);
      return;
    }
    isBusy = true;
    const eventId = randomUUID();
    try {
      await checkIfServerEnabled();
      const body = await readBody(request);
      writeDiagnostic({ eventId, outcome: 'received', bytes: body.length,
        hasAuthorization: request.headers.authorization !== undefined });
      let payload: unknown;
      try {
        const plaintext = decryptWebPush(body, config, request.headers);
        payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
      } catch {
        writeDiagnostic({ eventId, outcome: 'invalidCiphertextOrPayload' });
        respond(response, 400);
        return;
      }
      const decision = formatPush(payload, config);
      writeDiagnostic({ eventId, outcome: decision.outcome, locKey: decision.locKey });
      if (!decision.notification || !decision.identity) {
        respond(response, 204);
        return;
      }
      const now = Date.now();
      for (const [identity, timestamp] of seen) {
        if (now - timestamp >= DEDUP_LIFETIME_MS) seen.delete(identity);
      }
      if (seen.has(decision.identity)) {
        writeDiagnostic({ eventId, outcome: 'duplicate' });
        respond(response, 204);
        return;
      }
      // Marking before send suppresses ambiguous retry duplicates during this short probe
      if (seen.size >= MAX_DEDUP_ENTRIES) seen.delete(seen.keys().next().value!);
      seen.set(decision.identity, now);
      await sendNotification(config.nativeToken, decision.notification, checkIfServerEnabled);
      writeDiagnostic({ eventId, outcome: 'acceptedByFirebase' });
      respond(response, 201);
    } catch {
      writeDiagnostic({ eventId, outcome: 'notSentOrOutcomeUncertain' });
      respond(response, 503);
    } finally {
      isBusy = false;
    }
  }
}

async function readBody(request: IncomingMessage) {
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_PUSH_BYTES)) {
    throw new Error('Invalid push body size');
  }
  const timer = setTimeout(() => request.destroy(), REQUEST_TIMEOUT_MS);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Invalid push body chunk');
      size += chunk.length;
      if (size > MAX_PUSH_BYTES) throw new Error('Push body exceeds 4096 bytes');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

function checkIfPathMatches(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function respond(response: ServerResponse, status: number) {
  if (!response.headersSent && !response.destroyed) {
    response.writeHead(status, { 'Cache-Control': 'no-store' });
    response.end();
  }
}

function writeDiagnostic(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...value })}\n`);
}
