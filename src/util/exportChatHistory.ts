import type { ApiChat, ApiMessage } from '../api/types';
import { MAIN_THREAD_ID } from '../api/types';

import { isChatGroup } from '../global/helpers';
import { isActionMessage } from '../global/helpers/messages';
import { callApi } from '../api/gramjs';

const EXPORT_PAGE_LIMIT = 100;
const MAX_EXPORT_PAGES = 40;

export async function exportChatHistory(chat: ApiChat, filePrefix?: string) {
  const messages = await fetchExportableMessages(chat);
  if (!messages.length) {
    return false;
  }

  const payload = messages.map((message) => ({
    id: message.id,
    date: new Date(message.date * 1000).toISOString(),
    text: getExportText(message),
  }));

  downloadJson(getExportFileName(chat, filePrefix), payload);
  return true;
}

export function hasExportableMessage(messages?: ApiMessage[]) {
  return Boolean(messages?.some((message) => !isActionMessage(message)));
}

async function fetchExportableMessages(chat: ApiChat) {
  const collected: ApiMessage[] = [];
  let offsetId = 0;

  for (let page = 0; page < MAX_EXPORT_PAGES; page++) {
    const result = await callApi('fetchMessages', {
      chat,
      threadId: MAIN_THREAD_ID,
      offsetId,
      limit: EXPORT_PAGE_LIMIT,
    });
    if (!result?.messages.length) break;

    collected.push(...result.messages.filter((message) => !isActionMessage(message)));

    const oldestId = result.messages[result.messages.length - 1]?.id;
    if (!oldestId || oldestId === offsetId || result.messages.length < EXPORT_PAGE_LIMIT) {
      break;
    }
    offsetId = oldestId;
  }

  return collected;
}

function getExportFileName(chat: ApiChat, filePrefix?: string) {
  if (filePrefix) return `${filePrefix}-${chat.id}.json`;
  return isChatGroup(chat) ? `group-${chat.id}.json` : `chat-history-${chat.id}.json`;
}

function getExportText(message: ApiMessage) {
  const { content } = message;
  if (content.text?.text) return content.text.text;
  if (content.todo) return content.todo.todo.title.text;
  if (content.pollId) return 'Poll';
  if (content.photo) return 'Photo';
  if (content.video) return 'Video';
  if (content.voice) return 'Voice message';
  if (content.document) return content.document.fileName || 'File';
  return '';
}

function downloadJson(fileName: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, undefined, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
