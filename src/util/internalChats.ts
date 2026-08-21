import internalChatsConfig from '../internalChats.json';

const internalChatIds = new Set<string>(internalChatsConfig.internalChatIds);

export function isInternalChat(chatId: string) {
  return internalChatIds.has(chatId);
}
