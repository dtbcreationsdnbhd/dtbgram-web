import { IGE as AesIge } from '@cryptography/aes';

import { PUSH_SECRET_CACHE_NAME } from '../config';
import {
  bufferFromBase64, buffersEqual, bufferToUtf8, concat, readInt32LE,
} from './encoding/buffer';

const SECRET_KEY = '/push-secret';
const SECRET_BYTES = 256;
const AUTH_KEY_ID_BYTES = 8;
const MSG_KEY_BYTES = 16;
const HEADER_BYTES = AUTH_KEY_ID_BYTES + MSG_KEY_BYTES;
const LENGTH_BYTES = 4;
// MTProto 2.0 key derivation offset for messages sent by the server
const SERVER_KEY_OFFSET = 8;
const KEY_SLICE_BYTES = 36;
const SECOND_KEY_SLICE_OFFSET = 40;
const MSG_KEY_LARGE_OFFSET = 88;
const MSG_KEY_LARGE_SLICE_BYTES = 32;

// The page and the service worker share Cache Storage, so the worker can decrypt pushes while the app is closed
export async function getOrCreatePushSecret() {
  const savedSecret = await loadPushSecret();
  if (savedSecret) return savedSecret;

  const secret = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  const cache = await caches.open(PUSH_SECRET_CACHE_NAME);
  await cache.put(SECRET_KEY, new Response(secret));
  return secret;
}

export async function loadPushSecret() {
  const cache = await caches.open(PUSH_SECRET_CACHE_NAME);
  const response = await cache.match(SECRET_KEY);
  if (!response) return undefined;

  const secret = new Uint8Array(await response.arrayBuffer());
  return secret.length === SECRET_BYTES ? secret : undefined;
}

// Telegram encrypts pushes registered with a `secret` like MTProto 2.0 messages, with the secret as the auth key:
// `p` is base64url of `auth_key_id + msg_key + AES-256-IGE(int32 length + JSON + padding)`
export async function decryptTelegramPush(encoded: string, secret: Uint8Array) {
  const bytes = bufferFromBase64(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  if (bytes.length <= HEADER_BYTES) return undefined;

  const authKeyId = bytes.subarray(0, AUTH_KEY_ID_BYTES);
  const msgKey = bytes.subarray(AUTH_KEY_ID_BYTES, HEADER_BYTES);
  const secretHash = await digest('SHA-1', secret);
  if (!buffersEqual(authKeyId, secretHash.subarray(secretHash.length - AUTH_KEY_ID_BYTES))) return undefined;

  const firstSliceStart = SERVER_KEY_OFFSET;
  const secondSliceStart = SECOND_KEY_SLICE_OFFSET + SERVER_KEY_OFFSET;
  const [sha256a, sha256b] = await Promise.all([
    digest('SHA-256', concat(msgKey, secret.subarray(firstSliceStart, firstSliceStart + KEY_SLICE_BYTES))),
    digest('SHA-256', concat(secret.subarray(secondSliceStart, secondSliceStart + KEY_SLICE_BYTES), msgKey)),
  ]);
  const key = concat(sha256a.subarray(0, 8), sha256b.subarray(8, 24), sha256a.subarray(24, 32));
  const iv = concat(sha256b.subarray(0, 8), sha256a.subarray(8, 24), sha256b.subarray(24, 32));
  const plainText = wordsToBytes(new AesIge(key, iv).decrypt(bytes.slice(HEADER_BYTES)));

  const msgKeyLargeStart = MSG_KEY_LARGE_OFFSET + SERVER_KEY_OFFSET;
  const msgKeyLarge = await digest('SHA-256', concat(
    secret.subarray(msgKeyLargeStart, msgKeyLargeStart + MSG_KEY_LARGE_SLICE_BYTES),
    plainText,
  ));
  if (!buffersEqual(msgKey, msgKeyLarge.subarray(8, 8 + MSG_KEY_BYTES))) return undefined;

  const length = readInt32LE(plainText);
  if (length < 0 || length > plainText.length - LENGTH_BYTES) return undefined;
  return JSON.parse(bufferToUtf8(plainText.subarray(LENGTH_BYTES, LENGTH_BYTES + length)));
}

async function digest(algorithm: 'SHA-1' | 'SHA-256', data: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest(algorithm, data as Uint8Array<ArrayBuffer>));
}

// `@cryptography/aes` returns big-endian 32-bit words
function wordsToBytes(words: Uint32Array) {
  const wordBytes = Uint32Array.BYTES_PER_ELEMENT;
  const bytes = new Uint8Array(words.length * wordBytes);
  const view = new DataView(bytes.buffer);
  words.forEach((word, i) => view.setUint32(i * wordBytes, word));
  return bytes;
}
