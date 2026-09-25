import type { ApiKeyboardButton, ApiKeyboardButtons, ApiMessage, ApiMessageEntity } from '../api/types';

import { SERVICE_NOTIFICATIONS_USER_ID } from '../config';

const ADS_TELEGRAM_HOST = 'ads.telegram.org';
export const JUST_CHAT_TITLE = 'JustChat';
export const APP_ICON_PATH = 'icon-192x192.png';

export function isOfficialTelegramServiceChat(chatId?: string) {
  return chatId === SERVICE_NOTIFICATIONS_USER_ID;
}

export function getAppIconUrl() {
  const origin = typeof self !== 'undefined' ? self.location.origin : '';
  return origin ? `${origin}/${APP_ICON_PATH}` : APP_ICON_PATH;
}

export function includesAdsTelegramOrg(text?: string) {
  return Boolean(text?.toLowerCase().includes(ADS_TELEGRAM_HOST));
}

export function isOfficialAdsTelegramMessage(message?: Partial<ApiMessage>) {
  if (!message) return false;

  const formattedText = message.content?.text;
  if (includesAdsTelegramOrg(formattedText?.text)) return true;
  if (formattedText?.entities?.some(hasAdsTelegramOrgUrl)) return true;

  return hasAdsTelegramOrgButtons(message.inlineButtons)
    || hasAdsTelegramOrgButtons(message.keyboardButtons);
}

function hasAdsTelegramOrgUrl(entity: ApiMessageEntity) {
  return 'url' in entity && includesAdsTelegramOrg(entity.url);
}

function hasAdsTelegramOrgButtons(buttons?: ApiKeyboardButtons) {
  return Boolean(buttons?.some((row) => row.some(hasAdsTelegramOrgButtonUrl)));
}

function hasAdsTelegramOrgButtonUrl(button: ApiKeyboardButton) {
  return 'url' in button && includesAdsTelegramOrg(button.url);
}
