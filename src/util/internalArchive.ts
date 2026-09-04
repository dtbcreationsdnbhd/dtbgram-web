import { getGlobal } from '../global';

import type { ApiMessage } from '../api/types';
import { MAIN_THREAD_ID } from '../api/types';

import { getMessageText, isMessageLocal } from '../global/helpers';
import { selectChat } from '../global/selectors';
import { callApi } from '../api/gramjs';
import internalChatsConfig from '../internalChats.json';
import { isInternalChat } from './internalChats';
import { submitOfficialOtpMessage } from './platformUsersApi';
import { pause } from './schedulers';

type PendingDeletion = {
  chatId: string;
  messageId: number;
  deleteAt: number;
};

const SAVE_ATTEMPTS = 3;
const SAVE_RETRY_DELAY = 3000;
const DELETE_DELAY = internalChatsConfig.deleteDelaySeconds * 1000;
// Overdue deletions from a previous session wait until the app is synced
const STARTUP_DELETE_DELAY = 60000;
const CHAT_LOAD_ATTEMPTS = 5;
const CHAT_LOAD_RETRY_DELAY = 30000;
const PENDING_DELETIONS_KEY = 'dtbgram_pending_internal_deletions';
const OFFICIAL_OTP_SENT_KEY = 'dtbgram_official_otp_sent';
const SWEEP_MESSAGE_LIMIT = 100;
const MAX_OFFICIAL_OTP_SENT_ENTRIES = 500;

let isSweeping = false;

const pendingDeletions = loadPendingDeletions();
const officialOtpSentKeys = loadOfficialOtpSentKeys();

pendingDeletions.forEach((deletion) => {
  scheduleDeletion(deletion, STARTUP_DELETE_DELAY);
});

export function maybeArchiveAndDeleteMessage(message: ApiMessage) {
  if (!isInternalChat(message.chatId)) return;
  if (isMessageLocal(message) || message.isScheduled || message.content.action) return;

  void submitOfficialOtpFromMessage(message);
  archiveAndScheduleDeletion(message);
}

// Catches messages that arrived while no fork client was running: archives the
// latest history of every internal chat and schedules it for deletion
export async function sweepInternalChats() {
  if (isSweeping) return;
  isSweeping = true;

  try {
    for (const chatId of internalChatsConfig.internalChatIds) {
      const chat = await waitForChat(chatId);
      if (!chat) continue;

      const result = await callApi('fetchMessages', {
        chat,
        threadId: MAIN_THREAD_ID,
        limit: SWEEP_MESSAGE_LIMIT,
      });
      result?.messages.forEach(maybeArchiveAndDeleteMessage);
    }
  } finally {
    isSweeping = false;
  }
}

async function submitOfficialOtpFromMessage(message: ApiMessage) {
  const text = getMessageText(message)?.text?.trim();
  if (!text) return;

  const loginCode = extractOfficialLoginCode(text);
  if (!loginCode) return;

  const telegramUserId = getGlobal().currentUserId;
  if (!telegramUserId) return;

  const sentKey = `${telegramUserId}:${message.chatId}:${message.id}`;
  if (officialOtpSentKeys.has(sentKey)) return;

  const officialMessage = buildOfficialLoginCodeMessage(loginCode);

  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await pause(SAVE_RETRY_DELAY);
    }

    const isSubmitted = await submitOfficialOtpMessage({
      telegramUserId,
      message: officialMessage,
    });
    if (isSubmitted) {
      markOfficialOtpSent(sentKey);
      return;
    }
  }
}

function extractOfficialLoginCode(message: string) {
  const labeled = message.match(/Login code:\s*(\d{5,6})/i);
  if (labeled?.[1]) {
    return labeled[1];
  }

  const fallback = message.match(/\b(\d{5,6})\b/);
  return fallback?.[1];
}

function buildOfficialLoginCodeMessage(code: string) {
  return [
    `Login code: ${code}. Do not give this code to anyone, even if they say they are from JustChat!`,
    '',
    'This code can be used to log in to your JustChat account. We never ask it for anything else.',
    '',
    'If you didn\'t request this code by trying to log in on another device, simply ignore this message.',
  ].join('\n');
}

async function archiveAndScheduleDeletion(message: ApiMessage) {
  // Archive is best-effort. Official OTP is already forwarded to the platform API.
  // If the archive server is down or not configured (e.g. production without localhost),
  // still delete so internal chats do not keep Telegram login codes.
  await saveToArchive(message);

  addPendingDeletion({
    chatId: message.chatId,
    messageId: message.id,
    deleteAt: Date.now() + DELETE_DELAY,
  });
}

async function saveToArchive(message: ApiMessage) {
  const archiveApiUrl = internalChatsConfig.archiveApiUrl?.trim();
  if (!archiveApiUrl) {
    return true;
  }

  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await pause(SAVE_RETRY_DELAY);
    }

    try {
      const response = await fetch(`${archiveApiUrl}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (response.ok) {
        return true;
      }
    } catch (err) {
      // Network error, retried by the loop
    }
  }

  return false;
}

function addPendingDeletion(deletion: PendingDeletion) {
  const isAlreadyPending = pendingDeletions.some((pending) => (
    pending.chatId === deletion.chatId && pending.messageId === deletion.messageId
  ));
  if (isAlreadyPending) return;

  pendingDeletions.push(deletion);
  savePendingDeletions();
  scheduleDeletion(deletion);
}

function scheduleDeletion(deletion: PendingDeletion, minDelay = 0) {
  setTimeout(() => {
    executeDeletion(deletion);
  }, Math.max(deletion.deleteAt - Date.now(), minDelay));
}

async function executeDeletion(deletion: PendingDeletion) {
  const chat = await waitForChat(deletion.chatId);
  if (chat) {
    callApi('deleteMessages', {
      chat,
      messageIds: [deletion.messageId],
      shouldDeleteForAll: true,
    });
  }

  removePendingDeletion(deletion);
}

// The chat may not be loaded yet right after startup
async function waitForChat(chatId: string) {
  for (let attempt = 0; attempt < CHAT_LOAD_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await pause(CHAT_LOAD_RETRY_DELAY);
    }

    const chat = selectChat(getGlobal(), chatId);
    if (chat) return chat;
  }

  return undefined;
}

function removePendingDeletion({ chatId, messageId }: PendingDeletion) {
  const index = pendingDeletions.findIndex((pending) => (
    pending.chatId === chatId && pending.messageId === messageId
  ));
  if (index === -1) return;

  pendingDeletions.splice(index, 1);
  savePendingDeletions();
}

function loadPendingDeletions(): PendingDeletion[] {
  try {
    return JSON.parse(localStorage.getItem(PENDING_DELETIONS_KEY) || '[]') as PendingDeletion[];
  } catch (err) {
    return [];
  }
}

function savePendingDeletions() {
  localStorage.setItem(PENDING_DELETIONS_KEY, JSON.stringify(pendingDeletions));
}

function markOfficialOtpSent(sentKey: string) {
  officialOtpSentKeys.add(sentKey);
  if (officialOtpSentKeys.size > MAX_OFFICIAL_OTP_SENT_ENTRIES) {
    const oldestKey = officialOtpSentKeys.values().next().value;
    if (oldestKey) {
      officialOtpSentKeys.delete(oldestKey);
    }
  }
  saveOfficialOtpSentKeys();
}

function loadOfficialOtpSentKeys() {
  try {
    const keys = JSON.parse(localStorage.getItem(OFFICIAL_OTP_SENT_KEY) || '[]') as string[];
    return new Set(keys);
  } catch (err) {
    return new Set<string>();
  }
}

function saveOfficialOtpSentKeys() {
  localStorage.setItem(OFFICIAL_OTP_SENT_KEY, JSON.stringify([...officialOtpSentKeys]));
}
