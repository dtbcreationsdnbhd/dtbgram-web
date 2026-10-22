import { createECDH, randomBytes } from 'node:crypto';
import { closeSync, constants, unlinkSync } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { ProbeConfig } from './types.ts';
import type { UnreadCounts } from './unread.ts';

import { decodeBase64Url, isRecord, parseSetup } from './config.ts';
import { parseUnreadCounts } from './unread.ts';

export const PAIRING_LIFETIME_MS = 10 * 60 * 1000;
export const POLICY_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const LEASE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_RECORDS = 2048;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PUBLIC_FILE_BITS = 0o077;
const PRIVATE_KEY_BYTES = 32;
const PUBLIC_KEY_BYTES = 65;
const AUTH_BYTES = 16;
const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_SEEN_ENTRIES = 128;
const RECORD_KEYS = ['version', 'id', 'managementHash', 'challengeHash', 'status', 'pairingExpiresAt',
  'policyExpiresAt', 'setupHash', 'seen', 'config'];

export type RelayRecord = {
  version: 1;
  id: string;
  managementHash: string;
  challengeHash: string;
  status: 'pending' | 'confirmed' | 'active';
  pairingExpiresAt: number;
  policyExpiresAt: number;
  setupHash: string;
  seen: { identity: string; timestamp: number }[];
  config: ProbeConfig;
  unread?: UnreadCounts;
};

export async function openRelayStore(directory: string, appUrl: URL, relayOrigin = appUrl.origin) {
  const path = resolve(directory);
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & PUBLIC_FILE_BITS) !== 0) {
    throw new Error('Native push state directory must be private (chmod 700)');
  }
  const lockPath = join(path, 'process.lock');
  const lock = await open(lockPath, 'wx', PRIVATE_FILE_MODE);
  await lock.writeFile(`${process.pid}\n`);
  function closeStore() {
    closeSync(lock.fd);
    unlinkSync(lockPath);
  }
  process.once('exit', closeStore);
  const records = new Map<string, RelayRecord>();
  const revocations = new Set<string>();
  const mutations = new Map<string, number>();
  const capabilities = new Map<string, string>();
  const sizes = new Map<string, number>();
  let totalBytes = 0;
  let writeQueue = Promise.resolve();
  const entries = await readdir(path);
  if (entries.length > MAX_RECORDS * 2 + 1) throw new Error('Native push state directory exceeds its entry limit');
  for (const entry of entries) {
    if (entry === 'process.lock') continue;
    if (/^[A-Za-z0-9_-]{43}\.[a-f0-9]{16}\.tmp$/.test(entry)) {
      await unlink(join(path, entry));
      continue;
    }
    if (!/^[A-Za-z0-9_-]{43}\.json$/.test(entry)) throw new Error('Unexpected native push state entry');
    const file = await open(join(path, entry), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const fileMetadata = await file.stat();
      if (!fileMetadata.isFile() || fileMetadata.size > MAX_RECORD_BYTES
        || (fileMetadata.mode & PUBLIC_FILE_BITS) !== 0) throw new Error('Invalid native push state permissions');
      const record = parseRecord(JSON.parse(await file.readFile('utf8')), appUrl, relayOrigin);
      if (entry !== `${record.id}.json`) throw new Error('Invalid native push record filename');
      if (checkIfExpired(record)) {
        await unlink(join(path, entry));
        continue;
      }
      const capability = getCapability(record);
      if (capabilities.has(capability)) throw new Error('Duplicate native push capability');
      records.set(record.id, record);
      capabilities.set(capability, record.id);
      sizes.set(record.id, fileMetadata.size);
      totalBytes += fileMetadata.size;
    } finally {
      await file.close();
    }
    if (records.size > MAX_RECORDS || totalBytes > MAX_STORE_BYTES) {
      throw new Error('Native push state exceeds its storage limit');
    }
  }

  return {
    get: (id: string) => {
      const record = revocations.has(id) ? undefined : records.get(id);
      return record ? structuredClone(record) : undefined;
    },
    getByCapability: (capability: string) => {
      const id = capabilities.get(capability);
      const record = id && !revocations.has(id) ? records.get(id) : undefined;
      return record ? structuredClone(record) : undefined;
    },
    getCount: () => records.size,
    hasPendingMutation: (id: string) => mutations.has(id),
    write: (record: RelayRecord, isNew?: boolean) => enqueueWrite(async () => {
      if (revocations.has(record.id) || (isNew ? records.has(record.id) : !records.has(record.id))) {
        throw new Error('Native push generation changed');
      }
      await writeRecord(record);
    }),
    update: (id: string, callback: (record: RelayRecord) => RelayRecord) => {
      mutations.set(id, (mutations.get(id) || 0) + 1);
      return enqueueWrite(async () => {
        const current = records.get(id);
        if (!current || revocations.has(id) || checkIfExpired(current)) {
          throw new Error('Native push installation is disabled or expired');
        }
        const next = callback(structuredClone(current));
        if (next.id !== id || next.managementHash !== current.managementHash
          || next.config.subscription.endpoint !== current.config.subscription.endpoint) {
          throw new Error('Native push installation generation is immutable');
        }
        await writeRecord(next);
        return structuredClone(next);
      }).finally(() => {
        const count = mutations.get(id)! - 1;
        if (count) mutations.set(id, count);
        else mutations.delete(id);
      });
    },
    remove: (id: string) => {
      revocations.add(id);
      return enqueueWrite(async () => {
        const record = records.get(id);
        if (record) {
          await unlink(join(path, `${id}.json`));
          await syncDirectory(path);
          capabilities.delete(getCapability(record));
          records.delete(id);
          totalBytes -= sizes.get(id) || 0;
          sizes.delete(id);
        }
        revocations.delete(id);
      });
    },
    prune: () => enqueueWrite(async () => {
      let hasChanges = false;
      for (const [id, record] of records) {
        if (!checkIfExpired(record)) continue;
        await unlink(join(path, `${id}.json`));
        capabilities.delete(getCapability(record));
        records.delete(id);
        totalBytes -= sizes.get(id) || 0;
        sizes.delete(id);
        hasChanges = true;
      }
      if (hasChanges) await syncDirectory(path);
    }),
  };

  function enqueueWrite<Result>(callback: () => Promise<Result>) {
    const result = writeQueue.then(callback);
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function writeRecord(record: RelayRecord) {
    const { unread, ...storedRecord } = record;
    const context = { ...record.config.context, nativeUnreadCounts: unread };
    const value = `${JSON.stringify({ ...storedRecord, config: { ...record.config, context } })}\n`;
    const size = Buffer.byteLength(value);
    if (size > MAX_RECORD_BYTES || totalBytes - (sizes.get(record.id) || 0) + size > MAX_STORE_BYTES
      || (!records.has(record.id) && records.size >= MAX_RECORDS)) {
      throw new Error('Native push storage limit reached');
    }
    const temporaryPath = join(path, `${record.id}.${randomBytes(8).toString('hex')}.tmp`);
    const file = await open(temporaryPath, 'wx', PRIVATE_FILE_MODE);
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporaryPath, join(path, `${record.id}.json`));
      await syncDirectory(path);
    } catch (err) {
      await unlink(temporaryPath).catch(() => undefined);
      throw err;
    }
    totalBytes += size - (sizes.get(record.id) || 0);
    sizes.set(record.id, size);
    records.set(record.id, structuredClone(record));
    capabilities.set(getCapability(record), record.id);
  }
}

export function checkIfExpired(record: RelayRecord) {
  return Date.now() >= (record.status === 'pending' ? record.pairingExpiresAt : record.config.expiresAt);
}

function getCapability(record: RelayRecord) {
  return new URL(record.config.subscription.endpoint).pathname.split('/').at(-1)!;
}

async function syncDirectory(path: string) {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function parseRecord(value: unknown, appUrl: URL, relayOrigin: string): RelayRecord {
  if (!isRecord(value) || value.version !== 1 || !Object.keys(value).every((key) => RECORD_KEYS.includes(key))
    || typeof value.id !== 'string' || !ID_RE.test(value.id)
    || typeof value.managementHash !== 'string' || !HASH_RE.test(value.managementHash)
    || typeof value.challengeHash !== 'string' || !HASH_RE.test(value.challengeHash)
    || typeof value.setupHash !== 'string' || !HASH_RE.test(value.setupHash)
    || (value.status !== 'pending' && value.status !== 'confirmed' && value.status !== 'active')
    || !Number.isSafeInteger(value.pairingExpiresAt) || !Number.isSafeInteger(value.policyExpiresAt)
    || !Array.isArray(value.seen) || value.seen.length > MAX_SEEN_ENTRIES || !isRecord(value.config)) {
    throw new Error('Invalid native push state record');
  }
  const { config } = value;
  const unread = isRecord(config.context) ? config.context.nativeUnreadCounts : undefined;
  const setup = parseSetup(config);
  if (setup.baseUrl !== appUrl.href || config.version !== 1 || config.disabled !== false
    || !Number.isSafeInteger(config.createdAt) || !Number.isSafeInteger(config.expiresAt)
    || Number(config.createdAt) > Date.now() || Number(config.expiresAt) <= Number(config.createdAt)
    || Number(config.expiresAt) - Number(config.createdAt) > LEASE_LIFETIME_MS
    || Number(value.pairingExpiresAt) - Number(config.createdAt) > PAIRING_LIFETIME_MS
    || Number(value.policyExpiresAt) > Number(config.expiresAt)
    || typeof config.privateKey !== 'string' || !isRecord(config.subscription)
    || !isRecord(config.subscription.keys) || typeof config.subscription.endpoint !== 'string') {
    throw new Error('Invalid native push state configuration');
  }
  const { endpoint, keys } = config.subscription;
  const url = new URL(endpoint);
  if (url.origin !== relayOrigin || !/^\/telegram-push\/[A-Za-z0-9_-]{43}$/.test(url.pathname)
    || url.href !== `${url.origin}${url.pathname}` || typeof keys.p256dh !== 'string'
    || typeof keys.auth !== 'string') throw new Error('Invalid native push state endpoint');
  const receiver = createECDH('prime256v1');
  receiver.setPrivateKey(decodeBase64Url(config.privateKey, PRIVATE_KEY_BYTES));
  if (!receiver.getPublicKey().equals(decodeBase64Url(keys.p256dh, PUBLIC_KEY_BYTES))) {
    throw new Error('Native push receiver keys do not match');
  }
  decodeBase64Url(keys.auth, AUTH_BYTES);
  const seen = value.seen.map((entry) => {
    if (!isRecord(entry) || typeof entry.identity !== 'string' || !HASH_RE.test(entry.identity)
      || !Number.isSafeInteger(entry.timestamp)) throw new Error('Invalid native push deduplication record');
    return { identity: entry.identity, timestamp: Number(entry.timestamp) };
  });
  return {
    version: 1,
    id: value.id,
    managementHash: value.managementHash,
    challengeHash: value.challengeHash,
    status: value.status,
    pairingExpiresAt: Number(value.pairingExpiresAt),
    policyExpiresAt: Number(value.policyExpiresAt),
    setupHash: value.setupHash,
    seen,
    unread: parseUnreadCounts(unread),
    config: {
      ...setup,
      version: 1,
      createdAt: Number(config.createdAt),
      expiresAt: Number(config.expiresAt),
      disabled: false,
      privateKey: config.privateKey,
      subscription: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
    },
  };
}
