import type { PushUnreadSnapshot } from '../../src/util/pushNotificationContext.ts';

import { isRecord } from './validation.ts';

export type UnreadUpdate =
  | { kind: 'message'; chatId: string; messageId: number; hasUnknownSize: boolean }
  | { kind: 'read'; chatId: string; maxId: number }
  | { kind: 'delete'; chatId?: string; messageIds: number[] };

type UnreadEntry = {
  baseCount?: number;
  cutoffId: number;
  readMaxId: number;
  pendingIds: number[];
  deletedIds: number[];
  updatedAt: number;
};

export type UnreadCounts = Record<string, UnreadEntry>;

const MAX_CHATS = 64;
const MAX_TRACKED_IDS = 128;
const MAX_COUNT = 2147483647;
const CHAT_ID_RE = /^-?[1-9]\d{0,19}$/;
const ENTRY_KEYS = ['baseCount', 'cutoffId', 'readMaxId', 'pendingIds', 'deletedIds', 'updatedAt'];

export function reconcileUnreadCounts(
  previous: UnreadCounts = {}, snapshots: Record<string, PushUnreadSnapshot> = {},
) {
  const next = { ...previous };
  for (const [chatId, snapshot] of Object.entries(snapshots)) {
    const current = next[chatId];
    if (current && (snapshot.lastMessageId < current.cutoffId
      || snapshot.lastReadInboxMessageId < current.readMaxId)) continue;
    next[chatId] = {
      baseCount: snapshot.count,
      cutoffId: snapshot.lastMessageId,
      readMaxId: snapshot.lastReadInboxMessageId,
      pendingIds: current?.pendingIds.filter((id) => id > snapshot.lastMessageId) || [],
      deletedIds: current?.deletedIds.filter((id) => id > snapshot.lastMessageId) || [],
      updatedAt: Date.now(),
    };
  }
  return pruneCounts(next);
}

export function applyUnreadUpdate(previous: UnreadCounts = {}, update: UnreadUpdate) {
  const next = { ...previous };
  if (update.kind === 'delete' && !update.chatId) {
    for (const chatId of Object.keys(next)) {
      // Private chats and basic groups share message IDs; channel namespaces stay separate
      if (BigInt(chatId) > -1000000000000n) {
        next[chatId] = applyChatUpdate(next[chatId], update);
      }
    }
  } else if (update.chatId) {
    next[update.chatId] = applyChatUpdate(next[update.chatId], update);
  }
  return pruneCounts(next);
}

export function readUnreadCount(counts: UnreadCounts | undefined, chatId: string) {
  const entry = counts?.[chatId];
  if (!entry || entry.baseCount === undefined) return undefined;
  const count = entry.baseCount + entry.pendingIds.length;
  return count <= MAX_COUNT ? count : undefined;
}

export function checkIfMessageRead(counts: UnreadCounts | undefined, chatId: string, messageId: number) {
  const entry = counts?.[chatId];
  return Boolean(entry && (messageId <= entry.readMaxId || entry.deletedIds.includes(messageId)));
}

export function checkIfUnreadSnapshots(value: unknown): value is Record<string, PushUnreadSnapshot> {
  if (!isRecord(value) || Object.keys(value).length > MAX_CHATS) return false;
  return Object.entries(value).every(([chatId, entry]) => CHAT_ID_RE.test(chatId) && isRecord(entry)
    && Object.keys(entry).every((key) => ['count', 'lastMessageId', 'lastReadInboxMessageId'].includes(key))
    && checkIfCount(entry.count) && checkIfId(entry.lastMessageId) && checkIfId(entry.lastReadInboxMessageId)
    && entry.lastMessageId >= entry.lastReadInboxMessageId);
}

export function parseUnreadCounts(value: unknown): UnreadCounts {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > MAX_CHATS) throw new Error('Invalid unread state');
  const result: UnreadCounts = {};
  for (const [chatId, entry] of Object.entries(value)) {
    if (!CHAT_ID_RE.test(chatId) || !isRecord(entry)
      || !Object.keys(entry).every((key) => ENTRY_KEYS.includes(key))
      || (entry.baseCount !== undefined && !checkIfCount(entry.baseCount))
      || !checkIfId(entry.cutoffId) || !checkIfId(entry.readMaxId) || entry.readMaxId > entry.cutoffId
      || !checkIfId(entry.updatedAt) || !checkIfIds(entry.pendingIds, entry.cutoffId)
      || !checkIfIds(entry.deletedIds, entry.cutoffId)
      || entry.pendingIds.length + entry.deletedIds.length > MAX_TRACKED_IDS) throw new Error('Invalid unread entry');
    const { pendingIds, deletedIds } = entry;
    if (pendingIds.some((id) => deletedIds.includes(id))) throw new Error('Invalid overlapping unread IDs');
    result[chatId] = {
      baseCount: entry.baseCount,
      cutoffId: entry.cutoffId,
      readMaxId: entry.readMaxId,
      pendingIds: entry.pendingIds,
      deletedIds: entry.deletedIds,
      updatedAt: entry.updatedAt,
    };
  }
  return result;
}

function applyChatUpdate(previous: UnreadEntry | undefined, update: UnreadUpdate): UnreadEntry {
  const next: UnreadEntry = previous ? structuredClone(previous) : {
    cutoffId: 0, readMaxId: 0, pendingIds: [], deletedIds: [], updatedAt: Date.now(),
  };
  next.updatedAt = Date.now();
  if (update.kind === 'read') {
    if (update.maxId <= next.readMaxId) return next;
    next.readMaxId = update.maxId;
    if (update.maxId >= next.cutoffId) {
      next.cutoffId = update.maxId;
      next.baseCount = 0;
    } else if (next.baseCount) {
      // A partial read cannot identify which baseline messages remain unread
      next.baseCount = undefined;
    }
    next.pendingIds = next.pendingIds.filter((id) => id > update.maxId);
    next.deletedIds = next.deletedIds.filter((id) => id > next.cutoffId);
    return next;
  }
  if (update.kind === 'delete') {
    const deleted = new Set(update.messageIds);
    if (next.baseCount && update.messageIds.some((id) => id > next.readMaxId && id <= next.cutoffId)) {
      next.baseCount = undefined;
    }
    next.pendingIds = next.pendingIds.filter((id) => !deleted.has(id));
    next.deletedIds = [...new Set([...next.deletedIds, ...update.messageIds.filter((id) => id > next.cutoffId)])];
  } else if (update.messageId > next.cutoffId && !next.deletedIds.includes(update.messageId)
    && !next.pendingIds.includes(update.messageId)) {
    next.pendingIds.push(update.messageId);
    if (update.hasUnknownSize) next.baseCount = undefined;
  }
  if (next.pendingIds.length + next.deletedIds.length > MAX_TRACKED_IDS) {
    // Dropped message identities require a fresh authoritative snapshot
    next.baseCount = undefined;
    next.cutoffId = Math.max(next.cutoffId, ...next.pendingIds, ...next.deletedIds);
    next.pendingIds = [];
    next.deletedIds = [];
  }
  return next;
}

function pruneCounts(counts: UnreadCounts) {
  const entries = Object.entries(counts).sort((first, second) => second[1].updatedAt - first[1].updatedAt);
  return Object.fromEntries(entries.slice(0, MAX_CHATS));
}

function checkIfCount(value: unknown): value is number {
  return checkIfId(value) && value <= MAX_COUNT;
}

function checkIfId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function checkIfIds(value: unknown, cutoffId: number): value is number[] {
  return Array.isArray(value) && value.length <= MAX_TRACKED_IDS && new Set(value).size === value.length
    && value.every((id) => checkIfId(id) && id > cutoffId);
}
