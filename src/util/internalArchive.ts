import { getGlobal } from '../global';

import type { ApiMessage } from '../api/types';

import { MAIN_THREAD_ID } from '../api/types';
import { isMessageLocal } from '../global/helpers';
import { selectChat } from '../global/selectors';
import { callApi } from '../api/gramjs';
import internalChatsConfig from '../internalChats.json';
import { isInternalChat } from './internalChats';
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
const SWEEP_MESSAGE_LIMIT = 100;

let isSweeping = false;

const pendingDeletions = loadPendingDeletions();

pendingDeletions.forEach((deletion) => {
  scheduleDeletion(deletion, STARTUP_DELETE_DELAY);
});

export function maybeArchiveAndDeleteMessage(message: ApiMessage) {
  if (!isInternalChat(message.chatId)) return;
  if (isMessageLocal(message) || message.isScheduled || message.content.action) return;

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

async function archiveAndScheduleDeletion(message: ApiMessage) {
  const isSaved = await saveToArchive(message);
  // A message that could not be archived stays on Telegram, so it is never lost
  if (!isSaved) return;

  addPendingDeletion({
    chatId: message.chatId,
    messageId: message.id,
    deleteAt: Date.now() + DELETE_DELAY,
  });
}

async function saveToArchive(message: ApiMessage) {
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await pause(SAVE_RETRY_DELAY);
    }

    try {
      const response = await fetch(`${internalChatsConfig.archiveApiUrl}/messages`, {
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
