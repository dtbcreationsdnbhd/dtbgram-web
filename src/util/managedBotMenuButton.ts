import { processDeepLink } from './deeplink';
import { tryParseDeepLink } from './deepLinkParser';

const MENU_BUTTON_STORAGE_KEY = 'tt-managed-bot-menu-buttons';

export type StoredManagedBotMenuButton = {
  isEnabled: boolean;
  url?: string;
  text?: string;
};

export function getAllStoredMenuButtons(): Record<string, StoredManagedBotMenuButton> {
  try {
    const raw = localStorage.getItem(MENU_BUTTON_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, StoredManagedBotMenuButton>;
  } catch {
    return {};
  }
}

export function getStoredMenuButton(botId: string) {
  return getAllStoredMenuButtons()[botId];
}

export function storeMenuButton(botId: string, value: StoredManagedBotMenuButton) {
  try {
    const parsed = getAllStoredMenuButtons();
    parsed[botId] = value;
    localStorage.setItem(MENU_BUTTON_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // ignore
  }
}

export function openStoredManagedMiniApp(
  botId: string,
  onOpenWebApp: (url: string) => void,
) {
  const stored = getStoredMenuButton(botId);
  if (!stored?.isEnabled || !stored.url) return false;

  if (tryParseDeepLink(stored.url)) {
    processDeepLink(stored.url);
    return true;
  }

  onOpenWebApp(stored.url);
  return true;
}
