import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RelayRecord } from './relayStore.ts';
import type { ProbeConfig } from './types.ts';

import { createReceiver, hashValue, isRecord, parseSetup, readFirebaseCredentials } from './config.ts';
import { createFirebaseSender } from './firebase.ts';
import { formatPush, formatUnreadCount, parsePushUnreadUpdate } from './format.ts';
import {
  checkIfExpired, LEASE_LIFETIME_MS, openRelayStore, PAIRING_LIFETIME_MS, POLICY_LIFETIME_MS,
} from './relayStore.ts';
import {
  applyUnreadUpdate, checkIfMessageRead, readUnreadCount, reconcileUnreadCounts,
} from './unread.ts';
import { decryptWebPush, MAX_PUSH_BYTES } from './webPush.ts';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const MAX_PORT = 65535;
const ALLOWED_HOSTS = new Set([DEFAULT_HOST, '0.0.0.0']);
const ID_RE = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_PATH_RE = /^\/native-push\/devices\/([A-Za-z0-9_-]{43})(?:\/(confirm|activate))?$/;
const PUSH_PATH_RE = /^\/telegram-push\/([A-Za-z0-9_-]{43})$/;
const MAX_BODY_BYTES = 128 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;
const MAX_HEADERS_BYTES = 8192;
const MAX_HEADERS_COUNT = 32;
const REQUEST_TIMEOUT_MS = 10000;
const HEADERS_TIMEOUT_MS = 5000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const PAIRINGS_PER_HOUR = 120;
const PAIRINGS_PER_TOKEN_PER_HOUR = 3;
const MAX_RATE_ENTRIES = 512;
const MAX_CONCURRENT_REQUESTS = 64;
const MAX_SEEN_ENTRIES = 128;
const DEDUP_LIFETIME_MS = 10 * MINUTE_MS;
const SECRET_BYTES = 32;
const PRIVATE_FILE_MODE = 0o600;
const PRUNE_INTERVAL_MS = MINUTE_MS;
const PAIR_TITLE_KEY = 'NativePushPairTitle';
const PAIR_BODY_KEY = 'NativePushPairBody';

try {
  await startRelay();
} catch {
  // Startup diagnostics exclude secret files, tokens, notification contents, and endpoint URLs
  writeDiagnostic({ outcome: 'startupFailed' });
  process.exitCode = 1;
}

async function startRelay() {
  if (process.env.ENABLE_NATIVE_PUSH_RELAY !== '1') throw new Error('Native push relay is disabled');
  const { appUrl, relayOrigin, host, port, directory } = readConfiguration();
  const credentials = await readFirebaseCredentials(await resolveCredentialsPath());
  const sendNotification = createFirebaseSender(credentials);
  const labels = await readPairingLabels();
  const store = await openRelayStore(directory, appUrl, relayOrigin);
  const busyDevices = new Set<string>();
  const policyMutations = new Map<string, number>();
  const rates = new Map<string, { startedAt: number; count: number }>();
  let hasStopped = false;
  let activeRequests = 0;
  const server = createServer({ maxHeaderSize: MAX_HEADERS_BYTES }, (request, response) => {
    if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
      respond(response, 503);
      request.resume();
      return;
    }
    activeRequests += 1;
    void handleRequest(request, response).catch(() => {
      writeDiagnostic({ outcome: 'requestFailed' });
      respond(response, 503);
    }).finally(() => {
      activeRequests -= 1;
    });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.maxHeadersCount = MAX_HEADERS_COUNT;
  const pruneTimer = setInterval(() => {
    void store.prune().catch(() => writeDiagnostic({ outcome: 'statePruneFailed' }));
    pruneRates(rates);
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();
  process.once('SIGINT', stopServer);
  process.once('SIGTERM', stopServer);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      writeDiagnostic({ outcome: 'relayListening', port, records: store.getCount() });
      resolve();
    });
  });

  function stopServer() {
    hasStopped = true;
    clearInterval(pruneTimer);
    server.close();
    server.closeAllConnections();
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse) {
    if (hasStopped || process.env.ENABLE_NATIVE_PUSH_RELAY !== '1') {
      respond(response, 503);
      return;
    }
    if (request.url === '/health' && request.method === 'GET') {
      respond(response, 200);
      return;
    }
    const pushMatch = request.url?.match(PUSH_PATH_RE);
    if (pushMatch) {
      await handlePush(request, response, pushMatch[1]);
      return;
    }
    if (!request.url?.startsWith('/native-push/')) {
      respond(response, 404);
      return;
    }
    const isSameOriginRead = request.method === 'GET' && request.headers.origin === undefined;
    if (!isSameOriginRead && request.headers.origin !== appUrl.origin) {
      respond(response, 403);
      return;
    }
    response.setHeader('Access-Control-Allow-Origin', appUrl.origin);
    response.setHeader('Vary', 'Origin');
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Max-Age', '600');
      respond(response, 204);
      return;
    }
    if (request.url === '/native-push/pairings' && request.method === 'POST') {
      await handlePairing(request, response);
      return;
    }
    const deviceMatch = request.url.match(DEVICE_PATH_RE);
    if (!deviceMatch) {
      respond(response, 404);
      return;
    }
    await handleDevice(request, response, deviceMatch[1], deviceMatch[2]);
  }

  async function handlePairing(request: IncomingMessage, response: ServerResponse) {
    const body = await readManagementBody(request, response);
    if (!isRecord(body) || typeof body.id !== 'string' || !ID_RE.test(body.id)
      || typeof body.managementSecret !== 'string' || !ID_RE.test(body.managementSecret)) {
      respond(response, 400);
      return;
    }
    let setup;
    try {
      setup = parseSetup(body.setup);
    } catch {
      respond(response, 400);
      return;
    }
    if (setup.baseUrl !== appUrl.href || !setup.context.hasWebNotifications) {
      respond(response, 400);
      return;
    }
    const managementHash = hashValue(body.managementSecret);
    let existing = store.get(body.id);
    if (existing && checkIfExpired(existing) && !busyDevices.has(body.id)) {
      await store.remove(body.id);
      existing = undefined;
    }
    if (existing) {
      if (!checkIfEqual(existing.managementHash, managementHash) || checkIfExpired(existing)
        || existing.setupHash !== hashValue(JSON.stringify(setup))) {
        respond(response, 409);
        return;
      }
      respond(response, 200, { id: existing.id, expiresAt: existing.pairingExpiresAt });
      return;
    }
    if (busyDevices.has(body.id)) {
      respond(response, 409);
      return;
    }
    const tokenHash = hashValue(setup.nativeToken);
    if (!consumePairingRate(tokenHash)) {
      response.setHeader('Retry-After', '3600');
      respond(response, 429);
      return;
    }
    busyDevices.add(body.id);
    const now = Date.now();
    const challenge = randomBytes(SECRET_BYTES).toString('base64url');
    const receiver = createReceiver(relayOrigin);
    const config: ProbeConfig = {
      ...setup,
      ...receiver,
      version: 1,
      createdAt: now,
      expiresAt: now + LEASE_LIFETIME_MS,
      disabled: false,
    };
    const record: RelayRecord = {
      version: 1,
      id: body.id,
      managementHash,
      challengeHash: hashValue(challenge),
      status: 'pending',
      pairingExpiresAt: now + PAIRING_LIFETIME_MS,
      policyExpiresAt: now + POLICY_LIFETIME_MS,
      setupHash: hashValue(JSON.stringify(setup)),
      seen: [],
      unread: reconcileUnreadCounts(undefined, setup.context.unreadByChatId),
      config,
    };
    try {
      await store.write(record, true);
      const url = new URL(appUrl);
      // A distinct query makes Natively navigate when the app is already open
      url.searchParams.set('nativePushSetup', String(now));
      url.hash = `nativePushPair=${record.id}.${challenge}`;
      await sendNotification(setup.nativeToken, {
        title: labels.title,
        body: labels.body,
        tag: 'native-push-pairing',
        url: url.href,
        isSilent: false,
      }, () => checkIfCurrent(record, ['pending']));
      writeDiagnostic({ outcome: 'pairingAcceptedByFirebase' });
      respond(response, 201, { id: record.id, expiresAt: record.pairingExpiresAt });
    } catch {
      await store.remove(record.id);
      writeDiagnostic({ outcome: 'pairingFailedOrOutcomeUncertain' });
      respond(response, 503);
    } finally {
      busyDevices.delete(body.id);
    }
  }

  async function handleDevice(
    request: IncomingMessage, response: ServerResponse, id: string, action?: string,
  ) {
    const secret = parseBearerSecret(request);
    let record = store.get(id);
    if (!secret || (record && !checkIfEqual(record.managementHash, hashValue(secret)))) {
      respond(response, 404);
      return;
    }
    if (!action && request.method === 'DELETE') {
      await store.remove(id);
      respond(response, 204);
      return;
    }
    if (!record) {
      respond(response, 404);
      return;
    }
    if (checkIfExpired(record)) {
      await store.remove(id);
      respond(response, 410);
      return;
    }
    if (!action && request.method === 'GET') {
      respond(response, 200, buildEnrollment(record));
      return;
    }
    if (!action && request.method === 'PATCH') {
      policyMutations.set(id, (policyMutations.get(id) || 0) + 1);
      try {
        const body = await readManagementBody(request, response);
        let setup;
        try {
          setup = isRecord(body) ? parseSetup(body.setup) : undefined;
        } catch {
          respond(response, 400);
          return;
        }
        if (!setup || setup.userId !== record.config.userId || setup.nativeToken !== record.config.nativeToken
          || setup.baseUrl !== record.config.baseUrl || setup.appName !== record.config.appName
          || record.status === 'pending') {
          respond(response, 400);
          return;
        }
        record = await store.update(id, (current) => ({
          ...current,
          config: { ...current.config, ...setup },
          setupHash: hashValue(JSON.stringify(setup)),
          unread: reconcileUnreadCounts(current.unread, setup.context.unreadByChatId),
          policyExpiresAt: Math.min(Date.now() + POLICY_LIFETIME_MS, current.config.expiresAt),
        }));
        respond(response, 200, buildEnrollment(record));
      } finally {
        const remaining = policyMutations.get(id)! - 1;
        if (remaining) policyMutations.set(id, remaining);
        else policyMutations.delete(id);
      }
      return;
    }
    if (busyDevices.has(id)) {
      respond(response, 409);
      return;
    }
    busyDevices.add(id);
    try {
      if (action === 'confirm' && request.method === 'POST') {
        const body = await readManagementBody(request, response);
        if (!isRecord(body) || typeof body.challenge !== 'string' || !ID_RE.test(body.challenge)
          || !checkIfEqual(record.challengeHash, hashValue(body.challenge))) {
          respond(response, 403);
          return;
        }
        if (Date.now() >= record.pairingExpiresAt) {
          respond(response, 410);
          return;
        }
        if (record.status === 'pending') {
          record = await store.update(id, (current) => ({ ...current, status: 'confirmed' }));
        }
        respond(response, 200, buildEnrollment(record));
        return;
      }
      if (action === 'activate' && request.method === 'POST') {
        if (record.status === 'pending') {
          respond(response, 409);
          return;
        }
        record = await store.update(id, (current) => ({ ...current, status: 'active' }));
        respond(response, 200, buildEnrollment(record));
        return;
      }
      respond(response, 405);
    } finally {
      busyDevices.delete(id);
    }
  }

  async function handlePush(request: IncomingMessage, response: ServerResponse, capability: string) {
    const eventId = randomUUID();
    if (request.method !== 'POST') {
      writeDiagnostic({ eventId, outcome: 'unsupportedPushMethod', isPut: request.method === 'PUT' });
      respond(response, 405);
      return;
    }
    const record = store.getByCapability(capability);
    if (!record || checkIfExpired(record)) {
      writeDiagnostic({ eventId, outcome: 'unknownOrExpiredPushDestination' });
      respond(response, 410);
      return;
    }
    if (record.status !== 'active') {
      writeDiagnostic({ eventId, outcome: 'pushDestinationNotActive' });
      respond(response, 503);
      return;
    }
    const encoding = request.headers['content-encoding'];
    if (encoding !== 'aes128gcm' && encoding !== 'aesgcm') {
      writeDiagnostic({ eventId, outcome: 'unsupportedPushEncoding', hasEncoding: encoding !== undefined });
      respond(response, 415);
      return;
    }
    if (busyDevices.has(record.id) || policyMutations.has(record.id)) {
      writeDiagnostic({ eventId, outcome: 'pushDestinationBusy' });
      respond(response, 503);
      return;
    }
    busyDevices.add(record.id);
    try {
      const body = await readBody(request, MAX_PUSH_BYTES);
      writeDiagnostic({ eventId, outcome: 'pushReceived', encoding, bytes: body.length });
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
          decryptWebPush(body, record.config, request.headers),
        ));
      } catch {
        writeDiagnostic({ eventId, outcome: 'invalidCiphertextOrPayload' });
        respond(response, 400);
        return;
      }
      const hasCurrentPolicy = Date.now() < record.policyExpiresAt;
      const config = buildCurrentPolicy(record, hasCurrentPolicy);
      const decision = formatPush(payload, config);
      const unreadUpdate = parsePushUnreadUpdate(payload, record.config.userId);
      writeDiagnostic({ eventId, outcome: decision.outcome, locKey: decision.locKey });
      if (unreadUpdate && (unreadUpdate.kind === 'delete' || unreadUpdate.kind === 'read')) {
        await store.update(record.id, (current) => ({
          ...current, unread: applyUnreadUpdate(current.unread, unreadUpdate),
        }));
      }
      if (!decision.identity || !decision.notification) {
        if (unreadUpdate?.kind === 'message' && !config.excludedChatIds.includes(unreadUpdate.chatId)) {
          await store.update(record.id, (current) => ({
            ...current,
            unread: applyUnreadUpdate(current.unread, { ...unreadUpdate, hasUnknownSize: true }),
          }));
        }
        respond(response, 204);
        return;
      }
      const now = Date.now();
      const seen = record.seen.filter((entry) => now - entry.timestamp < DEDUP_LIFETIME_MS);
      if (seen.some((entry) => entry.identity === decision.identity)) {
        respond(response, 204);
        return;
      }
      // Durable marking before dispatch bounds duplicate notifications after an ambiguous send
      seen.push({ identity: decision.identity, timestamp: now });
      const setupHash = record.setupHash;
      const dispatchRecord = await store.update(record.id, (current) => {
        if (current.setupHash !== setupHash || policyMutations.has(current.id)) {
          throw new Error('Native push policy changed during dispatch');
        }
        return {
          ...current,
          seen: seen.slice(-MAX_SEEN_ENTRIES),
          unread: unreadUpdate?.kind === 'message'
            ? applyUnreadUpdate(current.unread, unreadUpdate) : current.unread,
        };
      });
      if (unreadUpdate?.kind === 'message'
        && checkIfMessageRead(dispatchRecord.unread, unreadUpdate.chatId, unreadUpdate.messageId)) {
        respond(response, 204);
        return;
      }
      const unreadCount = unreadUpdate?.kind === 'message'
        ? readUnreadCount(dispatchRecord.unread, unreadUpdate.chatId) : undefined;
      const notification = decision.outcome === 'previewReady' && unreadCount
        ? formatUnreadCount(decision.notification, unreadCount) : decision.notification;
      await sendNotification(dispatchRecord.config.nativeToken, notification, () => {
        checkIfCurrent(dispatchRecord, ['active']);
        const current = store.get(dispatchRecord.id)!;
        if (current.setupHash !== dispatchRecord.setupHash
          || (hasCurrentPolicy && current.policyExpiresAt <= Date.now())) {
          throw new Error('Native push policy changed during dispatch');
        }
      });
      writeDiagnostic({ eventId, outcome: 'acceptedByFirebase' });
      respond(response, 201);
    } catch {
      writeDiagnostic({ eventId, outcome: 'notSentOrOutcomeUncertain' });
      respond(response, 503);
    } finally {
      busyDevices.delete(record.id);
    }
  }

  function checkIfCurrent(record: RelayRecord, statuses: RelayRecord['status'][]) {
    const current = store.get(record.id);
    if (hasStopped || process.env.ENABLE_NATIVE_PUSH_RELAY !== '1' || !current || checkIfExpired(current)
      || policyMutations.has(record.id) || store.hasPendingMutation(record.id)
      || !statuses.includes(current.status)
      || current.config.subscription.endpoint !== record.config.subscription.endpoint
      || current.managementHash !== record.managementHash) {
      throw new Error('Native push installation is disabled or expired');
    }
  }

  function consumePairingRate(tokenHash: string) {
    pruneRates(rates);
    const budgets = [{ key: 'global', limit: PAIRINGS_PER_HOUR },
      { key: tokenHash, limit: PAIRINGS_PER_TOKEN_PER_HOUR }];
    const newEntries = budgets.filter(({ key }) => !rates.has(key)).length;
    if (rates.size + newEntries > MAX_RATE_ENTRIES
      || budgets.some(({ key, limit }) => (rates.get(key)?.count || 0) >= limit)) return false;
    budgets.forEach(({ key }) => {
      const entry = rates.get(key);
      rates.set(key, { startedAt: entry?.startedAt || Date.now(), count: (entry?.count || 0) + 1 });
    });
    return true;
  }
}

function readConfiguration() {
  const value = process.env.NATIVE_PUSH_APP_URL;
  const directory = process.env.NATIVE_PUSH_STATE_DIR;
  if (!value || !directory) throw new Error('Native push application URL and private state directory are required');
  const appUrl = new URL(value);
  if (appUrl.protocol !== 'https:' || appUrl.username || appUrl.password || appUrl.hash || appUrl.search) {
    throw new Error('Invalid native push application URL');
  }
  const relayUrl = new URL(process.env.NATIVE_PUSH_RELAY_URL || appUrl.origin);
  if (relayUrl.protocol !== 'https:' || relayUrl.username || relayUrl.password || relayUrl.search || relayUrl.hash
    || relayUrl.pathname !== '/') throw new Error('Invalid native push relay origin');
  const host = process.env.NATIVE_PUSH_HOST || DEFAULT_HOST;
  const port = Number(process.env.NATIVE_PUSH_PORT || DEFAULT_PORT);
  if (!ALLOWED_HOSTS.has(host) || !Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error('Invalid native push listening address');
  }
  return { appUrl, relayOrigin: relayUrl.origin, directory, host, port };
}

async function resolveCredentialsPath() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!json) {
    const path = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
    if (!path) throw new Error('Firebase server credentials are required');
    return path;
  }
  if (Buffer.byteLength(json) > MAX_SECRET_BYTES) throw new Error('Firebase server credentials are oversized');
  const directory = await mkdtemp(join(tmpdir(), 'native-push-relay-secrets-'));
  const path = join(directory, 'firebase.json');
  process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
  await writeFile(path, json, { flag: 'wx', mode: PRIVATE_FILE_MODE });
  return path;
}

async function readPairingLabels() {
  const source = await readFile(new URL('../../src/assets/localization/fallback.strings', import.meta.url), 'utf8');
  const values = [PAIR_TITLE_KEY, PAIR_BODY_KEY].map((key) => {
    const match = source.match(new RegExp(`^"${key}" = ("(?:[^"\\\\]|\\\\.)*");$`, 'm'));
    const value: unknown = match ? JSON.parse(match[1]) : undefined;
    if (typeof value !== 'string' || !value.trim()) throw new Error('Missing native push pairing translation');
    return value;
  });
  return { title: values[0], body: values[1] };
}

function buildEnrollment(record: RelayRecord) {
  return {
    id: record.id,
    status: record.status,
    expiresAt: record.status === 'pending' ? record.pairingExpiresAt : record.config.expiresAt,
    policyExpiresAt: record.policyExpiresAt,
    subscription: record.status === 'pending' ? undefined : record.config.subscription,
  };
}

function buildCurrentPolicy(record: RelayRecord, hasCurrentPolicy: boolean): ProbeConfig {
  if (hasCurrentPolicy) return record.config;
  return { ...record.config, context: { ...record.config.context, shouldShowPreviewsByChatId: {} } };
}

function parseBearerSecret(request: IncomingMessage) {
  const value = request.headers.authorization;
  return value?.startsWith('Bearer ') && ID_RE.test(value.slice('Bearer '.length))
    ? value.slice('Bearer '.length) : undefined;
}

function checkIfEqual(first: string, second: string) {
  const left = Buffer.from(first);
  const right = Buffer.from(second);
  return left.length === right.length && timingSafeEqual(left, right);
}

function pruneRates(rates: Map<string, { startedAt: number; count: number }>) {
  const now = Date.now();
  for (const [key, entry] of rates) {
    if (now - entry.startedAt >= HOUR_MS) rates.delete(key);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json'
    || request.headers['content-encoding'] !== undefined) throw new Error('Invalid management request encoding');
  return JSON.parse((await readBody(request, MAX_BODY_BYTES)).toString('utf8'));
}

async function readManagementBody(request: IncomingMessage, response: ServerResponse) {
  try {
    return await readJsonBody(request);
  } catch {
    respond(response, 400);
    return undefined;
  }
}

async function readBody(request: IncomingMessage, maximumBytes: number) {
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximumBytes)) {
    throw new Error('Oversized native push request');
  }
  const timer = setTimeout(() => request.destroy(), REQUEST_TIMEOUT_MS);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Invalid native push request body');
      size += chunk.length;
      if (size > maximumBytes) throw new Error('Oversized native push request');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

function respond(response: ServerResponse, status: number, body?: unknown) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

function writeDiagnostic(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...value })}\n`);
}
