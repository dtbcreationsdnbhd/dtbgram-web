import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import type { ProbeConfig } from './types.ts';

import { decodeBase64Url } from './config.ts';

export const MAX_PUSH_BYTES = 4096;
const SALT_BYTES = 16;
const HEADER_BYTES = 21;
const PUBLIC_KEY_BYTES = 65;
const AUTH_BYTES = 16;
const PRIVATE_KEY_BYTES = 32;
const TAG_BYTES = 16;
const MIN_RECORD_SIZE = 18;
const KEY_MATERIAL_BYTES = 32;
const CONTENT_KEY_BYTES = 16;
const NONCE_BYTES = 12;
const FINAL_DELIMITER = 2;
const UNCOMPRESSED_POINT = 4;
const LEGACY_PADDING_BYTES = 2;
const MAX_ENCRYPTION_HEADER_CHARACTERS = 1024;

export function decryptWebPush(
  body: Buffer, config: Pick<ProbeConfig, 'privateKey' | 'subscription'>, headers: IncomingHttpHeaders,
) {
  if (headers['content-encoding'] === 'aesgcm') return decryptLegacyWebPush(body, config, headers);
  if (headers['content-encoding'] !== 'aes128gcm') throw new Error('Unsupported Web Push encoding');
  return decryptModernWebPush(body, config);
}

function decryptLegacyWebPush(
  body: Buffer, config: Pick<ProbeConfig, 'privateKey' | 'subscription'>, headers: IncomingHttpHeaders,
) {
  const encryption = parseHeaderParameters(readEncryptionHeader(headers.encryption));
  const keys = readEncryptionHeader(headers['crypto-key']).split(',').map(parseHeaderParameters)
    .filter((parameters) => parameters.has('dh'));
  if (keys.length !== 1 || encryption.has('aesgcm')
    || (encryption.has('keyid') && encryption.get('keyid') !== keys[0].get('keyid'))) {
    throw new Error('Ambiguous legacy Web Push encryption headers');
  }
  const saltValue = encryption.get('salt');
  const publicKeyValue = keys[0].get('dh');
  if (!saltValue || !publicKeyValue) throw new Error('Missing legacy Web Push encryption parameters');
  const recordSizeValue = encryption.get('rs');
  if (recordSizeValue !== undefined && !/^\d+$/.test(recordSizeValue)) {
    throw new Error('Invalid legacy Web Push record size');
  }
  const recordSize = recordSizeValue === undefined ? MAX_PUSH_BYTES : Number(recordSizeValue);
  if (!Number.isSafeInteger(recordSize) || recordSize <= LEGACY_PADDING_BYTES
    || body.length > MAX_PUSH_BYTES || body.length < TAG_BYTES + LEGACY_PADDING_BYTES
    || body.length >= recordSize + TAG_BYTES) {
    throw new Error('Invalid single-record legacy Web Push body');
  }
  const salt = decodeBase64Url(saltValue.replace(/={1,2}$/, ''), SALT_BYTES);
  const senderPublicKey = decodeBase64Url(publicKeyValue.replace(/={1,2}$/, ''), PUBLIC_KEY_BYTES);
  if (senderPublicKey[0] !== UNCOMPRESSED_POINT) throw new Error('Invalid legacy Web Push public key');
  const receiverPublicKey = decodeBase64Url(config.subscription.keys.p256dh, PUBLIC_KEY_BYTES);
  const auth = decodeBase64Url(config.subscription.keys.auth, AUTH_BYTES);
  const receiver = createECDH('prime256v1');
  receiver.setPrivateKey(decodeBase64Url(config.privateKey, PRIVATE_KEY_BYTES));
  const sharedSecret = receiver.computeSecret(senderPublicKey);
  const keyMaterial = Buffer.from(hkdfSync(
    'sha256', sharedSecret, auth, Buffer.from('Content-Encoding: auth\0'), KEY_MATERIAL_BYTES,
  ));
  const publicKeyLength = Buffer.alloc(LEGACY_PADDING_BYTES);
  publicKeyLength.writeUInt16BE(PUBLIC_KEY_BYTES);
  const context = Buffer.concat([
    Buffer.from('P-256\0'), publicKeyLength, receiverPublicKey, publicKeyLength, senderPublicKey,
  ]);
  const key = Buffer.from(hkdfSync('sha256', keyMaterial, salt, Buffer.concat([
    Buffer.from('Content-Encoding: aesgcm\0'), context,
  ]), CONTENT_KEY_BYTES));
  const nonce = Buffer.from(hkdfSync('sha256', keyMaterial, salt, Buffer.concat([
    Buffer.from('Content-Encoding: nonce\0'), context,
  ]), NONCE_BYTES));
  const plaintext = decryptContent(body, key, nonce);
  const paddingEnd = LEGACY_PADDING_BYTES + plaintext.readUInt16BE(0);
  if (paddingEnd > plaintext.length || plaintext.subarray(LEGACY_PADDING_BYTES, paddingEnd)
    .some((value) => value !== 0)) throw new Error('Invalid legacy Web Push padding');
  return plaintext.subarray(paddingEnd);
}

function decryptModernWebPush(body: Buffer, config: Pick<ProbeConfig, 'privateKey' | 'subscription'>) {
  const ciphertextOffset = HEADER_BYTES + PUBLIC_KEY_BYTES;
  if (body.length > MAX_PUSH_BYTES || body.length < ciphertextOffset + TAG_BYTES + 1) {
    throw new Error('Invalid Web Push body size');
  }
  const recordSize = body.readUInt32BE(SALT_BYTES);
  const keyLength = body[HEADER_BYTES - 1];
  const ciphertext = body.subarray(ciphertextOffset);
  if (recordSize < MIN_RECORD_SIZE || ciphertext.length >= recordSize
    || keyLength !== PUBLIC_KEY_BYTES || body[HEADER_BYTES] !== UNCOMPRESSED_POINT) {
    throw new Error('Invalid single-record Web Push header');
  }
  const senderPublicKey = body.subarray(HEADER_BYTES, ciphertextOffset);
  const receiverPublicKey = decodeBase64Url(config.subscription.keys.p256dh, PUBLIC_KEY_BYTES);
  const auth = decodeBase64Url(config.subscription.keys.auth, AUTH_BYTES);
  const receiver = createECDH('prime256v1');
  receiver.setPrivateKey(decodeBase64Url(config.privateKey, PRIVATE_KEY_BYTES));
  const sharedSecret = receiver.computeSecret(senderPublicKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiverPublicKey, senderPublicKey]);
  const keyMaterial = Buffer.from(hkdfSync('sha256', sharedSecret, auth, keyInfo, KEY_MATERIAL_BYTES));
  const salt = body.subarray(0, SALT_BYTES);
  const key = Buffer.from(hkdfSync(
    'sha256', keyMaterial, salt, Buffer.from('Content-Encoding: aes128gcm\0'), CONTENT_KEY_BYTES,
  ));
  const nonce = Buffer.from(hkdfSync(
    'sha256', keyMaterial, salt, Buffer.from('Content-Encoding: nonce\0'), NONCE_BYTES,
  ));
  const plaintext = decryptContent(ciphertext, key, nonce);
  let delimiter = plaintext.length - 1;
  while (delimiter >= 0 && plaintext[delimiter] === 0) delimiter -= 1;
  if (delimiter < 0 || plaintext[delimiter] !== FINAL_DELIMITER) {
    throw new Error('Invalid Web Push final delimiter');
  }
  return plaintext.subarray(0, delimiter);
}

function decryptContent(ciphertext: Buffer, key: Buffer, nonce: Buffer) {
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(ciphertext.subarray(-TAG_BYTES));
  return Buffer.concat([decipher.update(ciphertext.subarray(0, -TAG_BYTES)), decipher.final()]);
}

function readEncryptionHeader(value: string | string[] | undefined) {
  if (typeof value !== 'string' || !value || value.length > MAX_ENCRYPTION_HEADER_CHARACTERS) {
    throw new Error('Invalid legacy Web Push encryption header');
  }
  return value;
}

function parseHeaderParameters(value: string) {
  const parameters = new Map<string, string>();
  value.split(';').forEach((parameter) => {
    const match = parameter.trim().match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*(?:"([a-zA-Z0-9_=-]+)"|([a-zA-Z0-9_=-]+))$/);
    if (!match || parameters.has(match[1])) throw new Error('Invalid legacy Web Push encryption parameter');
    parameters.set(match[1], match[2] || match[3]);
  });
  return parameters;
}
