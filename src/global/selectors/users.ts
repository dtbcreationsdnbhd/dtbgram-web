import type {
  ApiUser, ApiUserCommonChats,
  ApiUserFullInfo, ApiUserStatus,
} from '../../api/types';
import type { BotAppPermissions } from '../../types';
import type { GlobalState } from '../types';

import { MANAGER_BOT_USER_ID } from '../../config';
import { getMainUsername, isUserBot } from '../helpers';

export function selectUser<T extends GlobalState>(global: T, userId: string): ApiUser | undefined {
  return global.users.byId[userId];
}

export function selectManagedBotMenuButton<T extends GlobalState>(global: T, botId: string) {
  const stored = global.managedBotMenuButtonsById?.[botId];
  if (!stored?.isEnabled || !stored.url) {
    return undefined;
  }

  return {
    type: 'webApp' as const,
    text: stored.text || 'Open',
    url: stored.url,
  };
}

export function selectHasManagedMiniApp<T extends GlobalState>(global: T, botId?: string) {
  return Boolean(botId && selectManagedBotMenuButton(global, botId));
}

export function selectShouldShowBotOpenApp<T extends GlobalState>(global: T, user?: ApiUser) {
  if (!user) return false;
  if (user.hasMainMiniApp || user.id === MANAGER_BOT_USER_ID) return true;
  if (getMainUsername(user)?.toLowerCase() === 'botbrother123_bot') return true;
  return selectHasManagedMiniApp(global, user.id);
}

export function selectUserStatus<T extends GlobalState>(global: T, userId: string): ApiUserStatus | undefined {
  return global.users.statusesById[userId];
}

export function selectUserFullInfo<T extends GlobalState>(global: T, userId: string): ApiUserFullInfo | undefined {
  return global.users.fullInfoById[userId];
}

export function selectUserCommonChats<T extends GlobalState>(
  global: T, userId: string,
): ApiUserCommonChats | undefined {
  return global.users.commonChatsById[userId];
}

export function selectIsUserBlocked<T extends GlobalState>(global: T, userId: string) {
  return selectUserFullInfo(global, userId)?.isBlocked;
}

export function selectIsUserChatProtected<T extends GlobalState>(global: T, userId: string) {
  const fullInfo = selectUserFullInfo(global, userId);
  if (!fullInfo) return undefined;

  return Boolean(fullInfo.noForwardsMyEnabled || fullInfo.noForwardsPeerEnabled);
}

export function selectIsCurrentUserPremium<T extends GlobalState>(global: T) {
  if (!global.currentUserId) return false;

  return Boolean(global.users.byId[global.currentUserId].isPremium);
}

export function selectIsCurrentUserFrozen<T extends GlobalState>(global: T) {
  return Boolean(global.appConfig.freezeUntilDate);
}

export function selectIsPremiumPurchaseBlocked<T extends GlobalState>(global: T) {
  return global.appConfig.isPremiumPurchaseBlocked ?? true;
}

export function selectIsGiveawayGiftsPurchaseAvailable<T extends GlobalState>(global: T) {
  return global.appConfig.isGiveawayGiftsPurchaseAvailable ?? true;
}

/**
 * Slow, not to be used in `withGlobal`
 */
export function selectUserByPhoneNumber<T extends GlobalState>(global: T, phoneNumber: string) {
  const phoneNumberCleaned = phoneNumber.replace(/[^0-9]/g, '');

  return Object.values(global.users.byId).find((user) => user?.phoneNumber === phoneNumberCleaned);
}

export function selectBot<T extends GlobalState>(global: T, userId: string): ApiUser | undefined {
  const user = selectUser(global, userId);
  if (!user || !isUserBot(user)) {
    return undefined;
  }

  return user;
}

export function selectBotAppPermissions<T extends GlobalState>(
  global: T, userId: string,
): BotAppPermissions | undefined {
  return global.users.botAppPermissionsById[userId];
}
