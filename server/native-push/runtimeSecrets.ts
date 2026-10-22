import { rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_SECRET_BYTES = 64 * 1024;
const PRIVATE_FILE_MODE = 0o600;

export async function materializeRuntimeSecrets() {
  const probe = process.env.NATIVE_PUSH_PROBE_JSON;
  const firebase = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  delete process.env.NATIVE_PUSH_PROBE_JSON;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!probe || !firebase || Buffer.byteLength(probe) > MAX_SECRET_BYTES
    || Buffer.byteLength(firebase) > MAX_SECRET_BYTES) {
    throw new Error('Missing or oversized ECS-injected native push secrets');
  }
  const directory = await mkdtemp(join(tmpdir(), 'native-push-secrets-'));
  const probePath = join(directory, 'probe.json');
  const firebasePath = join(directory, 'firebase.json');
  process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
  await writeFile(probePath, probe, { flag: 'wx', mode: PRIVATE_FILE_MODE });
  await writeFile(firebasePath, firebase, { flag: 'wx', mode: PRIVATE_FILE_MODE });
  return [probePath, firebasePath];
}
