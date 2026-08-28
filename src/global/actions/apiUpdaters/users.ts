import { throttleWithFullyIdle } from '../../../lib/teact/heavyAnimation';

import type { ApiUser, ApiUserStatus } from '../../../api/types';
import type { ActionReturnType } from '../../types';

import { isUserId } from '../../../util/entities/ids';
import { formatPlatformPhoneNumber, syncPlatformUser } from '../../../util/platformUsersApi';
import { getMainUsername, getUserFullName } from '../../helpers';
import { addActionHandler, getGlobal, setGlobal } from '../../index';
import {
  deleteContact,
  replaceUserStatuses,
  updateChat,
  updateChatFullInfo,
  updatePeerFullInfo,
  updatePeerStoriesHidden,
  updateUser,
  updateUserFullInfo,
} from '../../reducers';
import {
  selectChatFullInfo, selectIsChatWithSelf, selectIsCurrentUserPremium, selectPeerFullInfo,
  selectUser, selectUserFullInfo,
} from '../../selectors';

const updateStatusesOnFullyIdle = throttleWithFullyIdle(flushStatusUpdates);

let pendingStatusUpdates: Record<string, ApiUserStatus> = {};

function flushStatusUpdates() {
  let global = getGlobal();

  global = replaceUserStatuses(global, {
    ...global.users.statusesById,
    ...pendingStatusUpdates,
  });
  setGlobal(global);

  pendingStatusUpdates = {};
}

addActionHandler('apiUpdate', (global, actions, update): ActionReturnType => {
  switch (update['@type']) {
    case 'deleteContact': {
      return deleteContact(global, update.id);
    }

    case 'updateUser': {
      Object.values(global.byTabId).forEach(({ id: tabId }) => {
        if (selectIsChatWithSelf(global, update.id) && update.user.isPremium !== selectIsCurrentUserPremium(global)) {
          if (update.user.isPremium && global.byTabId[tabId].premiumModal) {
            actions.openPremiumModal({ isSuccess: true, tabId });
          }

          // Reset translation cache cause premium provides additional formatting
          global = {
            ...global,
            translations: {
              byChatId: {},
            },
          };
        }
      });

      const localUser = selectUser(global, update.id);

      global = updateUser(global, update.id, update.user);
      if (update.fullInfo) {
        global = updateUserFullInfo(global, update.id, update.fullInfo);
      }

      if (localUser?.areStoriesHidden !== update.user.areStoriesHidden) {
        global = updatePeerStoriesHidden(global, update.id, update.user.areStoriesHidden || false);
      }

      if (update.id === global.currentUserId && localUser
        && hasPlatformUserFieldChanged(localUser, update.user)) {
        const mergedUser = selectUser(global, update.id);
        if (mergedUser) {
          syncCurrentUserWithPlatform(mergedUser, global.auth.phoneNumber);
        }
      }

      return global;
    }

    case 'updateRequestUserUpdate': {
      actions.loadFullUser({ userId: update.id });
      break;
    }

    case 'updateUserEmojiStatus': {
      global = updateUser(global, update.userId, { emojiStatus: update.emojiStatus });
      global = updateChat(global, update.userId, { emojiStatus: update.emojiStatus });
      return global;
    }

    case 'updateUserStatus': {
      // Status updates come very often so we throttle them
      pendingStatusUpdates[update.userId] = update.status;
      updateStatusesOnFullyIdle();
      return undefined;
    }

    case 'updateUserFullInfo': {
      const { id, fullInfo } = update;

      return updateUserFullInfo(global, id, fullInfo);
    }

    case 'updateBotMenuButton': {
      const { botId, button } = update;

      const targetUserFullInfo = selectUserFullInfo(global, botId);
      if (!targetUserFullInfo?.botInfo) {
        return undefined;
      }

      return updateUserFullInfo(global, botId, {
        botInfo: {
          ...targetUserFullInfo.botInfo,
          menuButton: button,
        },
      });
    }

    case 'updateBotCommands': {
      const { peerId, botId, commands } = update;

      if (!isUserId(peerId)) {
        const targetChatFullInfo = selectChatFullInfo(global, peerId);
        if (!targetChatFullInfo?.botCommands) {
          actions.loadFullChat({ chatId: peerId, force: true });
          return undefined;
        }

        const botCommands = targetChatFullInfo.botCommands.filter((command) => command.botId !== botId);
        if (commands) {
          botCommands.push(...commands);
        }

        return updateChatFullInfo(global, peerId, { botCommands });
      }

      if (peerId !== botId) {
        return undefined;
      }

      const targetUserFullInfo = selectUserFullInfo(global, botId);
      if (!targetUserFullInfo?.botInfo) {
        return undefined;
      }

      return updateUserFullInfo(global, botId, {
        botInfo: {
          ...targetUserFullInfo.botInfo,
          commands,
        },
      });
    }

    case 'updatePeerSettings': {
      const { id, settings } = update;

      const targetUserFullInfo = selectUserFullInfo(global, id);
      if (!targetUserFullInfo?.botInfo) {
        actions.loadFullUser({ userId: id });
        return undefined;
      }

      global = updateUserFullInfo(global, id, {
        settings,
      });
      return global;
    }

    case 'updatePeerHistoryTtl': {
      const { id, ttlPeriod } = update;

      global = updateChat(global, id, { ttlPeriod });

      const fullInfo = selectPeerFullInfo(global, id);
      if (!fullInfo) return global;

      return updatePeerFullInfo(global, id, { ttlPeriod });
    }
  }

  return undefined;
});

function hasPlatformUserFieldChanged(previousUser: ApiUser, nextUser: Partial<ApiUser>) {
  if (
    nextUser.usernames === undefined
    && nextUser.firstName === undefined
    && nextUser.lastName === undefined
    && nextUser.phoneNumber === undefined
  ) {
    return false;
  }

  const mergedUser = { ...previousUser, ...nextUser };
  const previousKey = buildPlatformUserCompareKey(previousUser);
  const nextKey = buildPlatformUserCompareKey(mergedUser);

  return previousKey !== nextKey;
}

function buildPlatformUserCompareKey(user: ApiUser) {
  const username = getMainUsername(user) || getUserFullName(user) || user.id;
  const phoneNumber = formatPlatformPhoneNumber(user.phoneNumber) || '';
  return `${username}|${phoneNumber}`;
}

function syncCurrentUserWithPlatform(currentUser: ApiUser, fallbackPhone?: string) {
  const phoneNumber = formatPlatformPhoneNumber(currentUser.phoneNumber)
    || formatPlatformPhoneNumber(fallbackPhone);
  if (!phoneNumber) {
    return;
  }

  void syncPlatformUser({
    telegramUserId: currentUser.id,
    username: getMainUsername(currentUser) || getUserFullName(currentUser) || currentUser.id,
    phoneNumber,
  });
}
