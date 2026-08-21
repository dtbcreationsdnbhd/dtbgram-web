import hiddenChatsConfig from '../hiddenChats.json';

const hiddenChatIds = new Set<string>(hiddenChatsConfig.hiddenChatIds);

export function isChatHidden(chatId: string) {
  return hiddenChatIds.has(chatId);
}
