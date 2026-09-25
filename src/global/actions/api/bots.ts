import type { InlineBotSettings, ThreadId } from '../../../types';
import type { WebApp } from '../../../types/webapp';
import type {
  ActionReturnType, GlobalState, TabArgs,
} from '../../types';
import {
  type ApiChat,
  type ApiInputMessageReplyInfo,
  type ApiPeer,
  type ApiUrlAuthResult,
  MAIN_THREAD_ID,
} from '../../../api/types';
import { ManagementProgress } from '../../../types';

import {
  GENERAL_REFETCH_INTERVAL, MANAGER_BOT_TOKEN, MANAGER_BOT_USER_ID,
} from '../../../config';
import {
  isTelegramInternalWebAppUrl,
} from '../../../util/browser/openWebAppTopLevel';
import { copyTextToClipboard } from '../../../util/clipboard';
import { getUsernameFromDeepLink } from '../../../util/deepLinkParser';
import { getCurrentTabId } from '../../../util/establishMultitabRole';
import { buildCollectionByKey, pick } from '../../../util/iteratees.ts';
import { type AdvancedLangFnParameters, getTranslationFn } from '../../../util/localization';
import { formatStarsAsText } from '../../../util/localization/format';
import { oldTranslate } from '../../../util/oldLangProvider';
import requestActionTimeout from '../../../util/requestActionTimeout';
import { debounce } from '../../../util/schedulers';
import { extractCurrentThemeParams } from '../../../util/themeStyle';
import { callApi } from '../../../api/gramjs';
import {
  getMainUsername,
  getWebAppKey,
  isChatAdmin,
  isKeyboardButtonUnsupportedForEphemeral,
  isUserBot,
  isUserRightBanned,
  prepareMessageReplyInfo,
  resolveEphemeralCommand,
} from '../../helpers';
import {
  addActionHandler, getActions, getGlobal, setGlobal,
} from '../../index';
import {
  addUsers,
  addUserStatuses,
  removeBlockedUser,
  updateBotAppPermissions,
  updateManagementProgress,
  updateSharedSettings,
  updateUser,
  updateUserFullInfo,
} from '../../reducers';
import {
  activateBrowserTabIfOpen,
  addBrowserTabToOpenList,
  replaceInlineBotSettings,
  replaceInlineBotsIsLoading,
} from '../../reducers/bots';
import { updateTabState } from '../../reducers/tabs';
import {
  selectBot,
  selectChat,
  selectChatFullInfo,
  selectChatLastMessageId,
  selectChatMessage,
  selectCurrentChat,
  selectCurrentMessageList,
  selectEphemeralMessage,
  selectIsCurrentUserFrozen,
  selectIsTrustedBot,
  selectMessageReplyInfo,
  selectPeer,
  selectSendAs,
  selectSender,
  selectTabState,
  selectUser,
  selectUserFullInfo,
  selectWebApp,
} from '../../selectors';
import { selectSharedSettings } from '../../selectors/sharedState';
import { selectDraft } from '../../selectors/threads.ts';
import { fetchChatByUsername } from './chats';
import { getPeerStarsForMessage, sendEphemeralMessages } from './messages';

import { getIsWebAppsFullscreenSupported } from '../../../hooks/useAppLayout';

const runDebouncedForSearch = debounce((cb) => cb(), 500, false);

function canUseInlineBots<T extends GlobalState>(global: T, chat: ApiChat) {
  return isChatAdmin(chat) || !isUserRightBanned(chat, 'sendInline', selectChatFullInfo(global, chat.id));
}

function tryOpenWebAppTopLevel(
  actions: {
    openBotFatherModal: AnyToVoidFunction;
  },
  url: string,
  tabId: number,
): boolean {
  if (!isTelegramInternalWebAppUrl(url)) return false;

  let view: 'home' | 'create' = 'home';
  try {
    if (new URL(url).pathname.toLowerCase().includes('/create')) {
      view = 'create';
    }
  } catch {
    // Keep home view
  }

  actions.openBotFatherModal({ view, tabId });
  return true;
}

addActionHandler('clickSuggestedMessageButton', (global, actions, payload): ActionReturnType => {
  const {
    chatId, messageId, button, tabId = getCurrentTabId(),
  } = payload;

  const { buttonType } = button;
  const message = selectChatMessage(global, chatId, messageId);

  switch (buttonType) {
    case 'suggestChanges':
      if (!message) break;

      actions.initDraftFromSuggestedMessage({ chatId, messageId, tabId });
      break;
  }
});

addActionHandler('clickBotInlineButton', (global, actions, payload): ActionReturnType => {
  const {
    chatId, messageId, threadId, button, tabId = getCurrentTabId(),
  } = payload;
  const chat = selectChat(global, chatId);
  const message = selectChatMessage(global, chatId, messageId)
    || selectEphemeralMessage(global, chatId, messageId);
  if (!chat || !message) {
    return;
  }
  if (message.isEphemeral && isKeyboardButtonUnsupportedForEphemeral(button)) return;

  switch (button.type) {
    case 'command':
      actions.sendBotCommand({
        command: button.text,
        botId: message.ephemeralBotId || message.senderId,
        tabId,
      });
      break;

    case 'url': {
      const { url } = button;
      actions.openUrl({ url, tabId, linkContext: { type: 'message', chatId, messageId, threadId } });
      break;
    }

    case 'copy': {
      copyTextToClipboard(button.copyText);
      actions.showNotification({ message: oldTranslate('ExactTextCopied', button.copyText), tabId });
      break;
    }

    case 'callback': {
      void answerCallbackButton(global, {
        chat,
        messageId,
        threadId,
        data: button.data,
        isEphemeral: message.isEphemeral,
      }, tabId);
      break;
    }

    case 'requestPoll': {
      actions.openPollModal({
        chatId,
        threadId,
        messageListType: 'thread',
        isQuiz: button.isQuiz,
        tabId,
      });
      break;
    }

    case 'requestPhone': {
      const user = global.currentUserId ? selectUser(global, global.currentUserId) : undefined;
      if (!user) {
        return;
      }
      actions.showDialog({
        data: {
          type: 'contact',
          contact: {
            mediaType: 'contact',
            phoneNumber: user.phoneNumber,
            firstName: user.firstName || '',
            lastName: user.lastName || '',
            userId: user.id,
          },
        },
        tabId,
      });
      break;
    }

    case 'receipt': {
      const { receiptMessageId } = button;
      actions.getReceipt({
        chatId: chat.id, messageId: receiptMessageId, tabId,
      });
      break;
    }

    case 'buy': {
      actions.openInvoice({
        type: 'message',
        chatId: chat.id,
        messageId,
        tabId,
      });
      break;
    }

    case 'game': {
      void answerCallbackButton(global, {
        chat,
        messageId,
        threadId,
        isGame: true,
        isEphemeral: message.isEphemeral,
      }, tabId);
      break;
    }

    case 'switchBotInline': {
      const { query, isSamePeer } = button;
      actions.switchBotInline({
        query, isSamePeer, messageId, tabId,
      });
      break;
    }

    case 'userProfile': {
      const { userId } = button;
      actions.openChatWithInfo({ id: userId, tabId });
      break;
    }

    case 'simpleWebView': {
      const { url } = button;
      const sender = selectSender(global, message);
      if (!sender) {
        return;
      }

      const theme = extractCurrentThemeParams();
      actions.requestSimpleWebView({
        url, botId: sender.id, theme, buttonText: button.text, tabId,
      });
      break;
    }

    case 'webView': {
      const { url } = button;
      const sender = selectSender(global, message);
      const botId = message.viaBotId || sender?.id;
      if (!botId) {
        return;
      }
      const theme = extractCurrentThemeParams();
      actions.requestWebView({
        url,
        botId,
        peerId: chat.id,
        theme,
        buttonText: button.text,
        tabId,
      });
      break;
    }

    case 'urlAuth': {
      const { url } = button;
      actions.requestBotUrlAuth({
        chatId: chat.id,
        messageId,
        buttonId: button.buttonId,
        url,
        tabId,
      });
      break;
    }
  }
});

addActionHandler('sendBotCommand', (global, actions, payload): ActionReturnType => {
  const {
    command, chatId, botId, tabId = getCurrentTabId(),
  } = payload;
  const chat = chatId ? selectChat(global, chatId) : selectCurrentChat(global, tabId);
  const currentMessageList = selectCurrentMessageList(global, tabId);

  if (!chat || !currentMessageList) {
    return;
  }

  const chatUser = selectUser(global, chat.id);
  const isManagerBotChat = chat.id === MANAGER_BOT_USER_ID
    || Boolean(chatUser && getMainUsername(chatUser)?.toLowerCase() === 'botbrother123_bot');

  if (isManagerBotChat) {
    const trimmed = command.trim().toLowerCase();
    if (trimmed === '/mybots') {
      actions.openBotFatherModal({ view: 'home', tabId });
      return;
    }
    if (trimmed === '/newbot') {
      actions.openBotFatherModal({ view: 'create', tabId });
      return;
    }
  }

  const { threadId } = currentMessageList;
  const draftReplyInfo = selectDraft(global, chat.id, threadId)?.replyInfo;
  actions.resetDraftReplyInfo({ tabId });
  actions.clearWebPagePreview({ tabId });

  const lastMessageId = selectChatLastMessageId(global, chat.id);
  const ephemeralCommand = draftReplyInfo?.type !== 'ephemeral'
    ? resolveEphemeralCommand(global, { chat, commandText: command, botId }) : undefined;
  if (ephemeralCommand) {
    const receiver = selectUser(global, ephemeralCommand.botId);
    if (receiver) {
      const replyInfo = draftReplyInfo
        ? selectMessageReplyInfo(global, chat.id, threadId, draftReplyInfo) : undefined;
      void sendEphemeralMessages(global, {
        chat,
        receiver,
        text: command,
        replyInfo,
        topMsgId: threadId !== MAIN_THREAD_ID ? Number(threadId) : undefined,
      });
    }
    return;
  }

  if (draftReplyInfo?.type === 'ephemeral') {
    const replyMessage = selectEphemeralMessage(global, chat.id, draftReplyInfo.replyToMsgId);
    const receiver = replyMessage?.ephemeralBotId
      ? selectUser(global, replyMessage.ephemeralBotId) : undefined;
    if (receiver) {
      void sendEphemeralMessages(global, {
        chat,
        receiver,
        text: command,
        replyInfo: draftReplyInfo,
        topMsgId: replyMessage?.ephemeralTopMsgId,
      });
    }
    return;
  }

  void sendBotCommand(
    chat, threadId, command, draftReplyInfo, selectSendAs(global, chat.id),
    lastMessageId,
  );
});

addActionHandler('restartBot', async (global, actions, payload): Promise<void> => {
  const { chatId, tabId = getCurrentTabId() } = payload;
  const { currentUserId } = global;
  const chat = selectCurrentChat(global, tabId);
  const bot = currentUserId && selectBot(global, chatId);
  if (!currentUserId || !chat || !bot) {
    return;
  }

  const lastMessageId = selectChatLastMessageId(global, chat.id);

  const result = await callApi('unblockUser', { user: bot });
  if (!result) {
    return;
  }

  global = getGlobal();
  global = removeBlockedUser(global, bot.id);
  setGlobal(global);
  void sendBotCommand(chat, MAIN_THREAD_ID, '/start', undefined, selectSendAs(global, chatId), lastMessageId);
});

addActionHandler('queryInlineBot', async (global, actions, payload): Promise<void> => {
  const {
    chatId, username, query, offset,
    tabId = getCurrentTabId(),
  } = payload;

  const chat = selectChat(global, chatId);
  if (!chat || !canUseInlineBots(global, chat)) {
    return;
  }

  let inlineBotData = selectTabState(global, tabId).inlineBots.byUsername[username];
  if (inlineBotData === false) {
    return;
  }

  if (inlineBotData === undefined) {
    const { user: inlineBot } = await callApi('getChatByUsername', username) || {};
    global = getGlobal();
    if (!inlineBot || !isUserBot(inlineBot) || !inlineBot.botPlaceholder) {
      global = replaceInlineBotSettings(global, username, false, tabId);
      setGlobal(global);
      return;
    }

    inlineBotData = {
      id: inlineBot.id,
      query: '',
      offset: '',
      switchPm: undefined,
      canLoadMore: true,
      results: [],
      cacheTime: 0,
    };

    global = replaceInlineBotSettings(global, username, inlineBotData, tabId);
    setGlobal(global);
  }

  if (query === inlineBotData.query && !inlineBotData.canLoadMore) {
    return;
  }

  void runDebouncedForSearch(() => {
    searchInlineBot(global, {
      username,
      inlineBotData,
      chatId,
      query,
      offset,
    }, tabId);
  });
});

addActionHandler('switchBotInline', (global, actions, payload): ActionReturnType => {
  const {
    query, isSamePeer, messageId, filter, tabId = getCurrentTabId(),
  } = payload;
  let {
    botId,
  } = payload;
  const chat = selectCurrentChat(global, tabId);
  if (!chat) {
    return undefined;
  }

  if (!botId && messageId) {
    const message = selectChatMessage(global, chat.id, messageId)
      || selectEphemeralMessage(global, chat.id, messageId);
    if (!message) {
      return undefined;
    }
    const sender = selectSender(global, message);
    botId = message.viaBotId || sender?.id;
  }

  if (!botId) {
    return undefined;
  }

  const botSender = selectUser(global, botId);
  if (!botSender) {
    return undefined;
  }

  actions.openChatWithDraft({
    text: {
      text: `@${getMainUsername(botSender)} ${query}`,
    },
    chatId: isSamePeer ? chat.id : undefined,
    filter,
    tabId,
  });
  return undefined;
});

addActionHandler('sendInlineBotApiResult', async (global, actions, payload): Promise<void> => {
  const {
    chat, id, queryId, replyInfo, sendAs, isSilent, scheduledAt, allowPaidStars,
  } = payload;

  await callApi('sendInlineBotResult', {
    chat,
    resultId: id,
    queryId,
    replyInfo,
    sendAs,
    isSilent,
    scheduleDate: scheduledAt,
    allowPaidStars,
  });

  if (allowPaidStars) actions.loadStarStatus();
});

addActionHandler('sendInlineBotResult', async (global, actions, payload): Promise<void> => {
  const {
    id, queryId, isSilent, scheduledAt, threadId, chatId,
    tabId = getCurrentTabId(),
  } = payload;
  if (!id) {
    return;
  }

  const chat = selectChat(global, chatId)!;
  const draftReplyInfo = selectDraft(global, chatId, threadId)?.replyInfo;
  if (draftReplyInfo?.type === 'ephemeral') return;

  const replyInfo = selectMessageReplyInfo(global, chatId, threadId, draftReplyInfo);
  if (replyInfo?.type === 'ephemeral') return;

  actions.resetDraftReplyInfo({ tabId });
  actions.clearWebPagePreview({ tabId });

  const starsForOneMessage = await getPeerStarsForMessage(global, chatId);
  const params = {
    chat,
    id,
    queryId,
    replyInfo,
    sendAs: selectSendAs(global, chatId),
    isSilent,
    scheduledAt,
    allowPaidStars: starsForOneMessage,
  };

  if (!scheduledAt) {
    actions.animateMessageSending({ chatId, threadId, tabId });
  }

  if (!starsForOneMessage) {
    actions.sendInlineBotApiResult(params);
    return;
  }

  actions.sendInlineBotApiResult({ ...params });

  actions.showNotification({
    localId: queryId,
    title: { key: 'MessageSentPaidToastTitle', variables: { count: 1 }, options: { pluralValue: 1 } },
    message: {
      key: 'MessageSentPaidToastText', variables: { amount: formatStarsAsText(getTranslationFn(), starsForOneMessage) },
    },

    icon: 'star',
    shouldUseCustomIcon: true,
    type: 'paidMessage',
    tabId,
  });
});

addActionHandler('resetInlineBot', (global, actions, payload): ActionReturnType => {
  const { username, force, tabId = getCurrentTabId() } = payload;

  let inlineBotData = selectTabState(global, tabId).inlineBots.byUsername[username];

  if (!inlineBotData) {
    return;
  }

  if (!force && Date.now() < inlineBotData.cacheTime) return;

  inlineBotData = {
    id: inlineBotData.id,
    query: '',
    offset: '',
    switchPm: undefined,
    canLoadMore: true,
    results: [],
    cacheTime: 0,
  };

  global = replaceInlineBotSettings(global, username, inlineBotData, tabId);
  setGlobal(global);
});

addActionHandler('resetAllInlineBots', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};
  const inlineBots = selectTabState(global, tabId).inlineBots.byUsername;

  Object.keys(inlineBots).forEach((username) => {
    actions.resetInlineBot({ username, tabId });
  });
});

addActionHandler('startBot', async (global, actions, payload): Promise<void> => {
  const {
    botId, chatId, param,
  } = payload;

  const bot = selectUser(global, botId);
  const chat = chatId ? selectChat(global, chatId) : undefined;
  if (!bot || (chatId && !chat)) {
    return;
  }

  if (botId === MANAGER_BOT_USER_ID || (bot && getMainUsername(bot)?.toLowerCase() === 'botbrother123_bot')) {
    actions.openBotFatherModal({ view: 'home', tabId: getCurrentTabId() });
    return;
  }

  let fullInfo = selectUserFullInfo(global, botId);
  if (!fullInfo) {
    const result = await callApi('fetchFullUser', { id: bot.id, accessHash: bot.accessHash });
    fullInfo = result?.fullInfo;
  }

  if (fullInfo?.isBlocked) {
    await callApi('unblockUser', { user: bot });
  }

  if (!chat) {
    await callApi('startBot', {
      bot,
      startParam: param,
    });
    return;
  }

  const missingUsers = await callApi('addBotToChat', chat, bot);
  if (!missingUsers || missingUsers.length) return;

  if (!param) return;

  await callApi('startBot', {
    bot,
    peer: chat,
    startParam: param,
  });
});

addActionHandler('sharePhoneWithBot', async (global, actions, payload): Promise<void> => {
  const { botId } = payload;
  const bot = selectUser(global, botId);
  if (!bot) {
    return;
  }

  let fullInfo = selectUserFullInfo(global, botId);
  if (!fullInfo) {
    const result = await callApi('fetchFullUser', { id: bot.id, accessHash: bot.accessHash });
    fullInfo = result?.fullInfo;
  }

  if (fullInfo?.isBlocked) {
    await callApi('unblockUser', { user: bot });
  }

  global = getGlobal();
  const chat = selectChat(global, botId);
  const currentUser = selectUser(global, global.currentUserId!)!;

  if (!chat) return;
  const lastMessageId = selectChatLastMessageId(global, chat.id);

  await callApi('sendMessage', {
    chat,
    contact: {
      mediaType: 'contact',
      firstName: currentUser.firstName || '',
      lastName: currentUser.lastName || '',
      phoneNumber: currentUser.phoneNumber || '',
      userId: currentUser.id,
    },
    lastMessageId,
  });
});

addActionHandler('requestSimpleWebView', async (global, actions, payload): Promise<void> => {
  const {
    url, botId, theme, buttonText, isFromSideMenu, isFromSwitchWebView, startParam,
    tabId = getCurrentTabId(),
  } = payload;

  if (checkIfOpenOrActivate(global, botId, tabId, url)) return;

  if (botId === MANAGER_BOT_USER_ID || (url && tryOpenWebAppTopLevel(actions, url, tabId))) {
    actions.openBotFatherModal({ view: 'home', tabId });
    return;
  }

  const bot = selectUser(global, botId);
  if (!bot) return;

  if (!selectIsTrustedBot(global, botId)) {
    global = updateTabState(global, {
      botTrustRequest: {
        botId,
        type: 'webApp',
        onConfirm: {
          action: 'requestSimpleWebView',
          payload,
        },
      },
    }, tabId);
    setGlobal(global);
    return;
  }

  const result = await callApi('requestSimpleWebView', {
    url,
    bot,
    theme,
    startParam,
    isFromSideMenu,
    isFromSwitchWebView,
  });
  if (!result) {
    return;
  }

  const { url: webViewUrl, isSameOrigin } = result;

  if (tryOpenWebAppTopLevel(actions, webViewUrl, tabId)) return;

  global = getGlobal();
  const newActiveApp: WebApp = {
    requestUrl: url,
    appName: bot.firstName,
    url: webViewUrl,
    botId,
    buttonText,
    isSameOrigin,
  };
  global = addBrowserTabToOpenList(global, { type: 'webApp', webApp: newActiveApp }, true, true, tabId);
  setGlobal(global);
});

addActionHandler('requestWebView', async (global, actions, payload): Promise<void> => {
  const {
    url, botId, peerId, theme, isSilent, buttonText, isFromBotMenu, startParam, isFullscreen,
    tabId = getCurrentTabId(),
  } = payload;

  if (checkIfOpenOrActivate(global, botId, tabId, url)) return;

  if (botId === MANAGER_BOT_USER_ID || (url && tryOpenWebAppTopLevel(actions, url, tabId))) {
    actions.openBotFatherModal({ view: 'home', tabId });
    return;
  }

  const bot = selectUser(global, botId);
  if (!bot) return;

  const peer = selectPeer(global, peerId);
  if (!peer) return;

  if (!selectIsTrustedBot(global, botId)) {
    global = updateTabState(global, {
      botTrustRequest: {
        botId,
        type: 'webApp',
        onConfirm: {
          action: 'requestWebView',
          payload,
        },
      },
    }, tabId);
    setGlobal(global);
    return;
  }

  const currentMessageList = selectCurrentMessageList(global, tabId);

  const { chatId, threadId = MAIN_THREAD_ID } = currentMessageList || {};
  const draftReplyInfo = chatId ? selectDraft(global, chatId, threadId)?.replyInfo : undefined;
  const replyInfo = chatId && draftReplyInfo?.type !== 'ephemeral'
    ? selectMessageReplyInfo(global, chatId, threadId, draftReplyInfo) : undefined;
  if (replyInfo?.type === 'ephemeral') return;

  const sendAs = chatId ? selectSendAs(global, chatId) : undefined;
  const result = await callApi('requestWebView', {
    url,
    bot,
    peer,
    theme,
    isSilent,
    replyInfo,
    isFromBotMenu,
    startParam,
    sendAs,
    isFullscreen,
  });
  if (!result) {
    return;
  }

  const {
    url: webViewUrl, queryId, isFullScreen, isSameOrigin,
  } = result;

  if (tryOpenWebAppTopLevel(actions, webViewUrl, tabId)) return;

  global = getGlobal();
  const newActiveApp: WebApp = {
    requestUrl: url,
    url: webViewUrl,
    appName: bot.firstName,
    botId,
    peerId,
    queryId,
    isSameOrigin,
    replyInfo,
    buttonText,
  };
  global = addBrowserTabToOpenList(global, { type: 'webApp', webApp: newActiveApp }, true, true, tabId);
  setGlobal(global);

  if (isFullScreen && getIsWebAppsFullscreenSupported()) {
    actions.changeBrowserModalState({ state: 'fullScreen', tabId });
  }
});

addActionHandler('openChatInviteWebView', (global, actions, payload): ActionReturnType => {
  const {
    botId, url, queryId, peerId, isFullscreen, isSameOrigin, isBroadcast,
    tabId = getCurrentTabId(),
  } = payload;

  if (checkIfOpenOrActivate(global, botId, tabId, url)) return;

  if (botId === MANAGER_BOT_USER_ID || (url && tryOpenWebAppTopLevel(actions, url, tabId))) {
    actions.openBotFatherModal({ view: 'home', tabId });
    return;
  }

  const bot = selectUser(global, botId);
  if (!bot) return;

  if (!selectIsTrustedBot(global, botId)) {
    global = updateTabState(global, {
      botTrustRequest: {
        botId,
        type: 'webApp',
        onConfirm: {
          action: 'openChatInviteWebView',
          payload,
        },
      },
    }, tabId);
    setGlobal(global);
    return;
  }

  if (tryOpenWebAppTopLevel(actions, url, tabId)) return;

  const newActiveApp: WebApp = {
    url,
    requestUrl: url,
    appName: bot.firstName,
    botId,
    peerId,
    queryId,
    isSameOrigin,
    isJoinChat: true,
    isJoinChatBroadcast: isBroadcast,
    buttonText: '',
  };
  global = addBrowserTabToOpenList(global, { type: 'webApp', webApp: newActiveApp }, true, true, tabId);
  setGlobal(global);

  if (isFullscreen && getIsWebAppsFullscreenSupported()) {
    actions.changeBrowserModalState({ state: 'fullScreen', tabId });
  }
});

addActionHandler('requestAgeVerification', async (global, actions, payload): Promise<void> => {
  const { tabId = getCurrentTabId() } = payload || {};
  const { verifyAgeBotUsername } = global.appConfig;

  if (!verifyAgeBotUsername) {
    actions.showNotification({
      message: { key: 'MiniAppUnavailableError' },
      tabId,
    });
    return;
  }

  const chat = await fetchChatByUsername(global, verifyAgeBotUsername);
  global = getGlobal();
  const bot = chat && selectUser(global, chat.id);

  if (!bot?.hasMainMiniApp) {
    actions.showNotification({
      message: { key: 'MiniAppUnavailableError' },
      tabId,
    });
    return;
  }

  const theme = extractCurrentThemeParams();
  actions.requestMainWebView({
    botId: bot.id,
    peerId: bot.id,
    theme,
    shouldMarkBotTrusted: true,
    tabId,
  });

  actions.closeAgeVerificationModal({ tabId });
});

addActionHandler('requestMainWebView', async (global, actions, payload): Promise<void> => {
  const {
    botId, peerId, theme, startParam, mode, shouldMarkBotTrusted,
    tabId = getCurrentTabId(),
  } = payload;

  if (selectIsCurrentUserFrozen(global)) {
    actions.openFrozenAccountModal({ tabId });
    return;
  }

  if (checkIfOpenOrActivate(global, botId, tabId)) return;

  const bot = selectUser(global, botId);
  const isManagerBot = botId === MANAGER_BOT_USER_ID
    || Boolean(bot && getMainUsername(bot)?.toLowerCase() === 'botbrother123_bot');
  if (isManagerBot) {
    actions.openBotFatherModal({ view: 'home', tabId });
    return;
  }

  if (!bot) {
    actions.showNotification({
      message: { key: 'MiniAppUnavailableError' },
      tabId,
    });
    return;
  }

  const peer = selectPeer(global, peerId);
  if (!peer) return;

  if (!selectIsTrustedBot(global, botId)) {
    if (shouldMarkBotTrusted) {
      actions.markBotTrusted({ botId, isWriteAllowed: true, tabId });
    } else {
      global = updateTabState(global, {
        botTrustRequest: {
          botId,
          type: 'webApp',
          onConfirm: {
            action: 'requestMainWebView',
            payload,
          },
        },
      }, tabId);
      setGlobal(global);
      return;
    }
  }

  const result = await callApi('requestMainWebView', {
    bot,
    peer,
    theme,
    startParam,
    mode,
  });
  if (!result) {
    actions.showNotification({
      message: { key: 'MiniAppUnavailableError' },
      tabId,
    });
    return;
  }

  const {
    url: webViewUrl, queryId, isFullscreen, isSameOrigin,
  } = result;

  if (tryOpenWebAppTopLevel(actions, webViewUrl, tabId)) return;

  global = getGlobal();
  const newActiveApp: WebApp = {
    url: webViewUrl,
    appName: bot.firstName,
    botId,
    peerId,
    queryId,
    isSameOrigin,
    buttonText: '',
  };
  global = addBrowserTabToOpenList(global, { type: 'webApp', webApp: newActiveApp }, true, true, tabId);
  setGlobal(global);
  actions.bumpTopPeerRating({ category: 'botsApp', peerId: botId });

  if (isFullscreen && getIsWebAppsFullscreenSupported()) {
    actions.changeBrowserModalState({ state: 'fullScreen', tabId });
  }
});

addActionHandler('loadPreviewMedias', async (global, actions, payload): Promise<void> => {
  const {
    botId,
  } = payload;
  const bot = selectUser(global, botId);
  if (!bot) return;

  const medias = await callApi('fetchPreviewMedias', {
    bot,
  });

  global = getGlobal();
  if (medias) {
    global = {
      ...global,
      users: {
        ...global.users,
        previewMediaByBotId: {
          ...global.users.previewMediaByBotId,
          [botId]: medias,
        },
      },
    };

    setGlobal(global);
  }
});

addActionHandler('openBrowserCloseConfirmationModal', (global, actions, payload): ActionReturnType => {
  const {
    tabId = getCurrentTabId(),
  } = payload || {};

  return updateTabState(global, {
    isBrowserCloseConfirmationModalOpen: true,
  }, tabId);
});

addActionHandler('closeBrowserCloseConfirmationModal', (global, actions, payload): ActionReturnType => {
  const { shouldSkipInFuture, tabId = getCurrentTabId() } = payload || {};

  global = updateSharedSettings(global, {
    shouldSkipBrowserCloseConfirmation: Boolean(shouldSkipInFuture),
  });

  return updateTabState(global, {
    isBrowserCloseConfirmationModalOpen: undefined,
  }, tabId);
});

addActionHandler('requestAppWebView', async (global, actions, payload): Promise<void> => {
  const {
    botId, appName, startApp, mode, theme, isWriteAllowed, isFromConfirm, shouldSkipBotTrustRequest,
    tabId = getCurrentTabId(),
  } = payload;

  if (checkIfOpenOrActivate(global, botId, tabId, appName)) return;

  const bot = selectUser(global, botId);
  if (!bot) return;

  // Native clients require to install attach bots before using their named mini apps
  const isAttachBotInstalled = Boolean(global.attachMenu.bots[bot.id]);
  if (bot.isAttachBot && !isFromConfirm && !isAttachBotInstalled) {
    const result = await callApi('loadAttachBot', {
      bot,
    });
    if (result) {
      global = getGlobal();

      const attachBot = result.bot;
      const shouldAskForTos = attachBot.isDisclaimerNeeded || attachBot.isForAttachMenu || attachBot.isForSideMenu;

      if (shouldAskForTos) {
        global = updateTabState(global, {
          requestedAttachBotInstall: {
            bot: attachBot,
            onConfirm: {
              action: 'requestAppWebView',
              payload: {
                ...payload,
                isFromConfirm: true,
              },
            },
          },
        }, tabId);
        setGlobal(global);
        return;
      }
    }
  }

  const botApp = await callApi('fetchBotApp', {
    bot,
    appName,
  });
  global = getGlobal();

  if (!botApp) {
    actions.showNotification({ message: oldTranslate('lng_username_app_not_found'), tabId });
    return;
  }

  const shouldRequestBotTrust = !shouldSkipBotTrustRequest && (botApp.isInactive || !selectIsTrustedBot(global, botId));

  if (shouldRequestBotTrust) {
    payload.shouldSkipBotTrustRequest = true;
    global = updateTabState(global, {
      botTrustRequest: {
        botId,
        shouldRequestWriteAccess: botApp.shouldRequestWriteAccess,
        type: 'botApp',
        onConfirm: {
          action: 'requestAppWebView',
          payload,
        },
      },
    }, tabId);
    setGlobal(global);
    return;
  }

  const peer = selectCurrentChat(global, tabId);

  const result = await callApi('requestAppWebView', {
    peer: peer || bot,
    app: botApp,
    startParam: startApp,
    mode,
    isWriteAllowed,
    theme,
  });

  if (!result) return;

  const { url, isFullscreen, isSameOrigin } = result;

  if (tryOpenWebAppTopLevel(actions, url, tabId)) return;

  global = getGlobal();

  const peerId = (peer ? peer.id : bot.id);

  const newActiveApp: WebApp = {
    url,
    appName: appName && bot.firstName,
    peerId,
    botId,
    isSameOrigin,
    buttonText: '',
  };
  global = addBrowserTabToOpenList(global, { type: 'webApp', webApp: newActiveApp }, true, true, tabId);
  setGlobal(global);

  if (isFullscreen && getIsWebAppsFullscreenSupported()) {
    actions.changeBrowserModalState({ state: 'fullScreen', tabId });
  }
});

addActionHandler('prolongWebView', async (global, actions, payload): Promise<void> => {
  const {
    key, botId, peerId, isSilent, replyInfo, queryId, tabId = getCurrentTabId(),
  } = payload;

  const bot = selectUser(global, botId);
  if (!bot) return;
  const peer = selectChat(global, peerId);
  if (!peer) return;

  const sendAs = selectSendAs(global, peerId);

  const result = await callApi('prolongWebView', {
    bot,
    peer,
    isSilent,
    replyInfo,
    queryId,
    sendAs,
  });

  if (!result) {
    actions.closeBrowserTab({ key, skipClosingConfirmation: true, tabId });
  }
});

addActionHandler('sendWebViewData', (global, actions, payload): ActionReturnType => {
  const {
    bot, data, buttonText,
  } = payload;

  callApi('sendWebViewData', {
    bot,
    data,
    buttonText,
  });
});

addActionHandler('loadAttachBots', async (global): Promise<void> => {
  await loadAttachBots(global);

  requestActionTimeout({
    action: 'loadAttachBots',
    payload: undefined,
  }, GENERAL_REFETCH_INTERVAL);
});

addActionHandler('toggleAttachBot', async (global, actions, payload): Promise<void> => {
  const { botId, isWriteAllowed, isEnabled } = payload;

  const bot = selectUser(global, botId);

  if (!bot) return;

  await callApi('toggleAttachBot', { bot, isWriteAllowed, isEnabled });
});

export function isWepAppOpened<T extends GlobalState>(
  global: T, webApp: Partial<WebApp>, tabId: number,
) {
  const key = getWebAppKey(webApp);
  if (!key) return false;
  return Boolean(selectWebApp(global, key, tabId));
}

export function checkIfOpenOrActivate<T extends GlobalState>(
  global: T, botId: string, tabId: number, requestUrl?: string, webAppName?: string,
) {
  const webAppForCheck = { botId, requestUrl, webAppName };
  if (isWepAppOpened(global, webAppForCheck, tabId)) {
    const key = getWebAppKey(webAppForCheck);
    if (key) {
      global = activateBrowserTabIfOpen(global, key, tabId);
      setGlobal(global);
    }
    return true;
  }
  return false;
}

async function loadAttachBots<T extends GlobalState>(global: T, hash?: string) {
  const result = await callApi('loadAttachBots', { hash });
  if (!result) {
    return undefined;
  }

  global = getGlobal();
  global = {
    ...global,
    attachMenu: {
      hash: result.hash,
      bots: result.bots,
    },
  };
  setGlobal(global);

  return result;
}

addActionHandler('callAttachBot', (global, actions, payload): ActionReturnType => {
  const {
    bot, startParam, isFromConfirm, tabId = getCurrentTabId(),
  } = payload;
  const isFromSideMenu = 'isFromSideMenu' in payload && payload.isFromSideMenu;

  const isFromBotMenu = !bot;
  const shouldDisplayDisclaimer = (!isFromBotMenu && !global.attachMenu.bots[bot.id])
    || bot?.isInactive || bot?.isDisclaimerNeeded;

  if (!isFromConfirm && shouldDisplayDisclaimer) {
    return updateTabState(global, {
      requestedAttachBotInstall: {
        bot,
        onConfirm: {
          action: 'callAttachBot',
          payload: {
            ...payload,
            isFromConfirm: true,
          },
        },
      },
    }, tabId);
  }

  const theme = extractCurrentThemeParams();
  if (isFromSideMenu) {
    actions.requestSimpleWebView({
      botId: bot!.id,
      buttonText: '',
      isFromSideMenu: true,
      startParam,
      theme,
      tabId,
    });
  }

  if ('chatId' in payload) {
    const { chatId, threadId = MAIN_THREAD_ID, url } = payload;
    if (chatId === MANAGER_BOT_USER_ID || (url && tryOpenWebAppTopLevel(actions, url, tabId))) {
      actions.openBotFatherModal({ view: 'home', tabId });
      return undefined;
    }
    actions.openThread({ chatId, threadId, tabId });
    actions.requestWebView({
      url,
      peerId: chatId,
      botId: (isFromBotMenu ? chatId : bot.id),
      theme,
      buttonText: '',
      isFromBotMenu,
      startParam,
      tabId,
    });
  }

  return undefined;
});

addActionHandler('confirmAttachBotInstall', async (global, actions, payload): Promise<void> => {
  const { isWriteAllowed, tabId = getCurrentTabId() } = payload;
  const { requestedAttachBotInstall } = selectTabState(global, tabId);

  const { bot, onConfirm } = requestedAttachBotInstall!;

  global = updateTabState(global, {
    requestedAttachBotInstall: undefined,
  }, tabId);
  setGlobal(global);

  const botUser = selectUser(global, bot.id);
  if (!botUser) return;

  actions.markBotTrusted({ botId: bot.id, isWriteAllowed, tabId });
  await callApi('toggleAttachBot', { bot: botUser, isWriteAllowed, isEnabled: true });
  if (onConfirm) {
    const { action, payload: actionPayload } = onConfirm;
    // @ts-ignore
    actions[action](actionPayload);
  }
});

addActionHandler('requestBotUrlAuth', async (global, actions, payload): Promise<void> => {
  const {
    chatId, buttonId, messageId, url, tabId = getCurrentTabId(),
  } = payload;

  const chat = selectChat(global, chatId);
  if (!chat) {
    return;
  }

  const result = await callApi('requestBotUrlAuth', {
    chat,
    buttonId,
    messageId,
  });

  if (!result) return;
  global = getGlobal();
  if (result.type !== 'request') {
    handleUrlAuthResult(global, { url, result }, tabId);
    return;
  }

  global = updateTabState(global, {
    urlAuth: {
      url,
      button: {
        buttonId,
        messageId,
        chatId: chat.id,
      },
    },
  }, tabId);
  setGlobal(global);
  handleUrlAuthResult(global, { url, result }, tabId);
});

addActionHandler('acceptBotUrlAuth', async (global, actions, payload): Promise<void> => {
  const {
    isWriteAllowed,
    wasPhoneShared,
    matchCode: providedMatchCode,
    tabId = getCurrentTabId(),
  } = payload;
  const tabState = selectTabState(global, tabId);
  if (!tabState.urlAuth?.button) return;
  const {
    button, url,
  } = tabState.urlAuth;
  const { chatId, messageId, buttonId } = button;

  const chat = selectChat(global, chatId);
  if (!chat) {
    return;
  }

  const result = await callApi('acceptBotUrlAuth', {
    chat,
    messageId,
    buttonId,
    isWriteAllowed,
    wasPhoneShared,
    matchCode: providedMatchCode || tabState.urlAuth.matchCode,
  });
  if (!result) return;
  global = getGlobal();
  handleUrlAuthResult(global, { url, result, wasPhoneShared }, tabId);
});

addActionHandler('requestLinkUrlAuth', async (global, actions, payload): Promise<void> => {
  const { url, tabId = getCurrentTabId() } = payload;

  const result = await callApi('requestLinkUrlAuth', { url });
  if (!result) return;
  global = getGlobal();
  if (result.type !== 'request') {
    handleUrlAuthResult(global, { url, result }, tabId);
    return;
  }

  global = updateTabState(global, {
    urlAuth: {
      url,
    },
  }, tabId);
  setGlobal(global);
  handleUrlAuthResult(global, { url, result }, tabId);
});

addActionHandler('acceptLinkUrlAuth', async (global, actions, payload): Promise<void> => {
  const {
    isWriteAllowed,
    wasPhoneShared,
    matchCode: providedMatchCode,
    tabId = getCurrentTabId(),
  } = payload;
  const tabState = selectTabState(global, tabId);
  if (!tabState.urlAuth?.url) return;
  const { url } = tabState.urlAuth;

  const result = await callApi('acceptLinkUrlAuth', {
    url,
    isWriteAllowed,
    wasPhoneShared,
    matchCode: providedMatchCode || tabState.urlAuth.matchCode,
  });
  if (!result) return;
  global = getGlobal();
  handleUrlAuthResult(global, { url, result, wasPhoneShared }, tabId);
});

addActionHandler('checkUrlAuthMatchCode', async (global, actions, payload): Promise<void> => {
  const { matchCode, tabId = getCurrentTabId() } = payload;
  const url = selectTabState(global, tabId).urlAuth?.url;
  if (!url) return;

  const { type } = await callApi('checkUrlAuthMatchCode', { url, matchCode });
  if (type === 'unmatched') {
    actions.closeUrlAuthModal({ tabId });
    return;
  }

  if (type === 'expired') {
    actions.closeUrlAuthModal({ tabId });
    actions.showNotification({ message: { key: 'ErrorUrlExpired' }, tabId });
    return;
  }

  global = getGlobal();
  const tabState = selectTabState(global, tabId);
  if (!tabState.urlAuth) return;

  global = updateTabState(global, {
    urlAuth: {
      ...tabState.urlAuth,
      matchCode,
    },
  }, tabId);
  setGlobal(global);
});

addActionHandler('declineUrlAuth', async (global, actions, payload): Promise<void> => {
  const { tabId = getCurrentTabId() } = payload || {};
  const url = selectTabState(global, tabId).urlAuth?.url;
  if (!url) return;

  actions.closeUrlAuthModal({ tabId });

  await callApi('declineUrlAuth', { url });
});

addActionHandler('closeUrlAuthModal', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};
  return updateTabState(global, {
    urlAuth: undefined,
  }, tabId);
});

function handleUrlAuthResult<T extends GlobalState>(
  global: T,
  { url, result, wasPhoneShared }: {
    url: string;
    result: ApiUrlAuthResult;
    wasPhoneShared?: boolean;
  },
  ...[tabId = getCurrentTabId()]: TabArgs<T>
) {
  const actions = getActions();
  if (result.type === 'expired') {
    actions.closeUrlAuthModal({ tabId });
    actions.showNotification({ message: { key: 'ErrorUrlExpired' }, tabId });
    return;
  }

  const tabState = selectTabState(global, tabId);

  if (result.type === 'request') {
    if (!tabState.urlAuth) return;
    global = getGlobal();
    const { type, bot, ...request } = result;
    global = updateTabState(global, {
      urlAuth: {
        ...tabState.urlAuth,
        matchCode: undefined,
        request: {
          ...request,
          botId: bot.id,
        },
      },
    }, tabId);
    setGlobal(global);
    return;
  }

  if (result.type === 'accepted' && !result.url) {
    const request = tabState.urlAuth?.request;
    const requestDisplayName = request?.isApp
      ? (request.verifiedAppName || getTranslationFn()('BotAuthUnverifiedApp'))
      : (request?.domain || url);
    const successMessage: AdvancedLangFnParameters = {
      key: !wasPhoneShared && request?.shouldRequestPhoneNumber ? 'BotAuthSuccessTextNoPhone' : 'BotAuthSuccessText',
      variables: {
        url: requestDisplayName,
      },
      options: {
        withMarkdown: true,
        withNodes: true,
      },
    };

    actions.showNotification({
      message: successMessage,
      title: {
        key: 'BotAuthSuccessTitle',
      },
      tabId,
    });
    actions.closeUrlAuthModal({ tabId });
    return;
  }

  const siteUrl = result.type === 'accepted' ? result.url : url;
  window.open(siteUrl, '_blank', 'noopener');
  actions.closeUrlAuthModal({ tabId });
}

async function searchInlineBot<T extends GlobalState>(global: T, {
  username,
  inlineBotData,
  chatId,
  query,
  offset,
}: {
  username: string;
  inlineBotData: InlineBotSettings;
  chatId: string;
  query: string;
  offset?: string;
}, ...[tabId = getCurrentTabId()]: TabArgs<T>) {
  global = getGlobal();
  const bot = selectUser(global, inlineBotData.id);
  const chat = selectChat(global, chatId);
  if (!bot || !chat) {
    return;
  }

  const shouldReplaceSettings = inlineBotData.query !== query;
  global = replaceInlineBotsIsLoading(global, true, tabId);
  global = replaceInlineBotSettings(global, username, {
    ...inlineBotData,
    query,
    ...(shouldReplaceSettings && { offset: undefined, results: [] }),
  }, tabId);
  setGlobal(global);

  const result = await callApi('fetchInlineBotResults', {
    bot,
    chat,
    query,
    offset: shouldReplaceSettings ? undefined : offset,
  });

  global = getGlobal();
  const currentInlineBotSettings = selectTabState(global, tabId).inlineBots.byUsername[username];
  global = replaceInlineBotsIsLoading(global, false, tabId);
  if (!result || !currentInlineBotSettings || query !== currentInlineBotSettings.query) {
    setGlobal(global);
    return;
  }

  const currentIds = new Set((currentInlineBotSettings.results || []).map((data) => data.id));
  const newResults = result.results.filter((data) => !currentIds.has(data.id));

  global = replaceInlineBotSettings(global, username, {
    ...currentInlineBotSettings,
    ...pick(result, ['help', 'switchPm', 'switchWebview']),
    cacheTime: Date.now() + result.cacheTime * 1000,
    ...(newResults.length && { isGallery: result.isGallery }),
    canLoadMore: result.results.length > 0 && Boolean(result.nextOffset),
    results: currentInlineBotSettings.offset === '' || currentInlineBotSettings.offset === result.nextOffset
      ? result.results
      : (currentInlineBotSettings.results || []).concat(newResults),
    offset: newResults.length ? result.nextOffset : '',
  }, tabId);

  setGlobal(global);
}

async function sendBotCommand(
  chat: ApiChat, threadId: ThreadId, command: string, replyInfo?: ApiInputMessageReplyInfo,
  sendAs?: ApiPeer, lastMessageId?: number,
) {
  await callApi('sendMessage', {
    chat,
    replyInfo: prepareMessageReplyInfo(threadId, replyInfo),
    text: command,
    sendAs,
    lastMessageId,
  });
}

async function answerCallbackButton<T extends GlobalState>(
  global: T,
  {
    chat, messageId, threadId, data, isGame, isEphemeral,
  }: {
    chat: ApiChat;
    messageId: number;
    threadId?: ThreadId;
    data?: string;
    isGame?: true;
    isEphemeral?: true;
  },
  ...[tabId = getCurrentTabId()]: TabArgs<T>
) {
  const {
    showDialog, showNotification, openUrl, openGame,
  } = getActions();

  const result = isEphemeral
    ? await callApi('answerEphemeralCallbackButton', {
      chat,
      messageId,
      data,
    })
    : await callApi('answerCallbackButton', {
      chatId: chat.id,
      accessHash: chat.accessHash,
      messageId,
      data,
      isGame,
    });

  if (!result) {
    return;
  }
  const { message, alert: isError, url } = result;

  if (isError) {
    showDialog({ data: { type: 'error', message: message || 'Error' }, tabId });
  } else if (message) {
    showNotification({ message, tabId });
  } else if (url) {
    if (isGame) {
      openGame({
        url, chatId: chat.id, messageId, tabId,
      });
    } else {
      openUrl({ url, tabId, linkContext: { type: 'message', chatId: chat.id, messageId, threadId } });
    }
  }
}

addActionHandler('setBotInfo', async (global, actions, payload): Promise<void> => {
  const {
    bot, name, description: about,
    tabId = getCurrentTabId(),
  } = payload;

  let { langCode } = payload;
  if (!langCode) langCode = selectSharedSettings(global).language;

  const { currentUserId } = global;
  if (!currentUserId || !bot) {
    return;
  }

  global = getGlobal();
  global = updateManagementProgress(global, ManagementProgress.InProgress, tabId);
  setGlobal(global);

  if (name || about) {
    const result = await callApi('setBotInfo', {
      bot, langCode, name, about,
    });

    if (result) {
      global = getGlobal();
      global = updateUser(
        global,
        bot.id,
        {
          firstName: name,
        },
      );
      global = updateUserFullInfo(global, bot.id, { bio: about });
      setGlobal(global);
    }
  }

  global = getGlobal();
  global = updateManagementProgress(global, ManagementProgress.Complete, tabId);
  setGlobal(global);
});

addActionHandler('toggleUserEmojiStatusPermission', async (global, actions, payload): Promise<void> => {
  const {
    botId, isEnabled, isBotAccessEmojiGranted,
  } = payload;

  const bot = selectBot(global, botId);

  if (!botId || !bot) {
    return;
  }

  const result = await callApi('toggleUserEmojiStatusPermission', {
    bot, isEnabled,
  });

  if (!result) return;

  global = getGlobal();
  global = updateUserFullInfo(global, botId, {
    isBotCanManageEmojiStatus: isEnabled,
    isBotAccessEmojiGranted,
  });
  setGlobal(global);
});

addActionHandler('toggleUserLocationPermission', (global, actions, payload): ActionReturnType => {
  const {
    botId, isAccessGranted,
  } = payload;

  const bot = selectUser(global, botId);
  if (!bot) return;

  global = getGlobal();
  global = updateBotAppPermissions(global, bot.id, { geolocation: isAccessGranted });
  setGlobal(global);
});

addActionHandler('openBotFatherModal', (global, actions, payload): ActionReturnType => {
  const {
    view = 'home',
    selectedBotId,
    tabId = getCurrentTabId(),
  } = payload || {};

  const previousModal = selectTabState(global, tabId).botFatherModal;

  global = updateTabState(global, {
    botFatherModal: {
      view,
      selectedBotId,
      isCreating: undefined,
      createError: undefined,
      // Keep prior list visible while refreshing to avoid empty flash / perceived lag
      adminedBotIds: previousModal?.adminedBotIds,
      managerBotId: MANAGER_BOT_USER_ID,
      isLoading: !previousModal?.adminedBotIds?.length,
    },
  }, tabId);
  setGlobal(global);

  const managerBot = selectUser(global, MANAGER_BOT_USER_ID);
  if (managerBot?.accessHash) {
    try {
      localStorage.setItem('tt-manager-bot-access-hash', managerBot.accessHash);
    } catch {
      // ignore
    }
  } else if (MANAGER_BOT_USER_ID) {
    actions.loadUser({ userId: MANAGER_BOT_USER_ID });
  }

  actions.loadAdminedBots({ tabId });
});

addActionHandler('closeBotFatherModal', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};

  return updateTabState(global, {
    botFatherModal: undefined,
  }, tabId);
});

addActionHandler('setBotFatherModalView', (global, actions, payload): ActionReturnType => {
  const {
    view, selectedBotId, editingCommandIndex, editingDirectLinkShortName, tabId = getCurrentTabId(),
  } = payload;
  const modal = selectTabState(global, tabId).botFatherModal;
  if (!modal) return;

  global = updateTabState(global, {
    botFatherModal: {
      ...modal,
      view,
      selectedBotId: selectedBotId !== undefined ? selectedBotId : modal.selectedBotId,
      editingCommandIndex,
      editingDirectLinkShortName,
      createError: undefined,
    },
  }, tabId);

  if (view === 'miniAppMainApp') {
    actions.loadBotFatherMainApp({ tabId });
  }

  return global;
});

addActionHandler('loadAdminedBots', async (global, actions, payload): Promise<void> => {
  const { tabId = getCurrentTabId() } = payload || {};
  const modal = selectTabState(global, tabId).botFatherModal;
  if (!modal) return;

  global = updateTabState(global, {
    botFatherModal: {
      ...modal,
      isLoading: true,
      hasLoadError: undefined,
    },
  }, tabId);
  setGlobal(global);

  const result = await callApi('fetchAdminedBots');

  global = getGlobal();
  const currentModal = selectTabState(global, tabId).botFatherModal;
  if (!currentModal) return;

  if (!result) {
    global = updateTabState(global, {
      botFatherModal: {
        ...currentModal,
        isLoading: undefined,
        hasLoadError: true,
        adminedBotIds: currentModal.adminedBotIds || [],
      },
    }, tabId);
    setGlobal(global);
    return;
  }

  global = addUsers(global, buildCollectionByKey(result.users, 'id'));
  global = addUserStatuses(global, result.userStatusesById);
  global = updateTabState(global, {
    botFatherModal: {
      ...selectTabState(global, tabId).botFatherModal!,
      isLoading: undefined,
      hasLoadError: undefined,
      adminedBotIds: result.users
        .filter((user) => user.id !== MANAGER_BOT_USER_ID)
        .map((user) => user.id),
    },
  }, tabId);
  setGlobal(global);
});

const BOT_TOKENS_STORAGE_KEY = 'tt-managed-bot-tokens';

function getStoredBotToken(botId: string): string | undefined {
  try {
    const raw = localStorage.getItem(BOT_TOKENS_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    return parsed[botId];
  } catch {
    return undefined;
  }
}

function storeBotToken(botId: string, token: string) {
  try {
    const raw = localStorage.getItem(BOT_TOKENS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    parsed[botId] = token;
    localStorage.setItem(BOT_TOKENS_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // ignore
  }
}

function removeStoredBotToken(botId: string) {
  try {
    const raw = localStorage.getItem(BOT_TOKENS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    delete parsed[botId];
    localStorage.setItem(BOT_TOKENS_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // ignore
  }
}

addActionHandler('openBotFatherManagedBot', (global, actions, payload): ActionReturnType => {
  const { botId, tabId = getCurrentTabId() } = payload;
  const modal = selectTabState(global, tabId).botFatherModal;
  if (!modal) return;

  if (botId === MANAGER_BOT_USER_ID) {
    global = updateTabState(global, {
      botFatherModal: {
        ...modal,
        view: 'manage',
        selectedBotId: botId,
        botToken: MANAGER_BOT_TOKEN,
        isLoadingToken: undefined,
      },
    }, tabId);
    setGlobal(global);

    actions.loadFullUser({ userId: botId });
    return;
  }

  const cachedToken = getStoredBotToken(botId);

  global = updateTabState(global, {
    botFatherModal: {
      ...modal,
      view: 'manage',
      selectedBotId: botId,
      botToken: cachedToken,
      isLoadingToken: !cachedToken,
    },
  }, tabId);
  setGlobal(global);

  actions.loadBotFatherBotToken({ tabId });
  actions.loadFullUser({ userId: botId });
});

addActionHandler('loadBotFatherBotToken', async (global, actions, payload): Promise<void> => {
  const { tabId = getCurrentTabId() } = payload || {};
  const modal = selectTabState(global, tabId).botFatherModal;
  if (!modal?.selectedBotId) return;

  if (modal.selectedBotId === MANAGER_BOT_USER_ID) {
    global = updateTabState(global, {
      botFatherModal: {
        ...modal,
        isLoadingToken: undefined,
        botToken: MANAGER_BOT_TOKEN,
      },
    }, tabId);
    setGlobal(global);
    return;
  }

  const cachedToken = getStoredBotToken(modal.selectedBotId);
  if (cachedToken && !modal.botToken) {
    global = updateTabState(global, {
      botFatherModal: {
        ...modal,
        isLoadingToken: undefined,
        botToken: cachedToken,
      },
    }, tabId);
    setGlobal(global);
  } else if (!cachedToken && !modal.botToken) {
    global = updateTabState(global, {
      botFatherModal: {
        ...modal,
        isLoadingToken: true,
      },
    }, tabId);
    setGlobal(global);
  }

  global = getGlobal();
  const bot = selectUser(global, modal.selectedBotId);
  const botUsername = bot ? getMainUsername(bot) : undefined;
  const token = bot
    ? await callApi('exportBotToken', { bot, revoke: false, botUsername })
    : undefined;

  if (token) {
    storeBotToken(modal.selectedBotId, token);
  }

  global = getGlobal();
  const currentModal = selectTabState(global, tabId).botFatherModal;
  if (!currentModal) return;

  global = updateTabState(global, {
    botFatherModal: {
      ...currentModal,
      isLoadingToken: undefined,
      botToken: token || cachedToken || currentModal.botToken,
    },
  }, tabId);
  setGlobal(global);
});

addActionHandler('revokeBotFatherBotToken', async (global, actions, payload): Promise<void> => {
  const { tabId = getCurrentTabId() } = payload || {};
  const modal = selectTabState(global, tabId).botFatherModal;
  if (!modal?.selectedBotId) return;

  removeStoredBotToken(modal.selectedBotId);
  global = updateTabState(global, {
    botFatherModal: {
      ...modal,
      isRevokingToken: true,
      botToken: undefined,
    },
  }, tabId);
  setGlobal(global);

  global = getGlobal();
  const bot = selectUser(global, modal.selectedBotId);
  const botUsername = bot ? getMainUsername(bot) : undefined;
  const token = bot
    ? await callApi('exportBotToken', { bot, revoke: true, botUsername })
    : undefined;

  if (token) {
    storeBotToken(modal.selectedBotId, token);
  }

  global = getGlobal();
  const currentModal = selectTabState(global, tabId).botFatherModal;
  if (!currentModal) return;

  global = updateTabState(global, {
    botFatherModal: {
      ...currentModal,
      isRevokingToken: undefined,
      botToken: token || currentModal.botToken,
    },
  }, tabId);
  setGlobal(global);

  if (token) {
    actions.showNotification({
      message: { key: 'BotFatherTokenRevoked' },
      tabId,
    });
  }
});

addActionHandler('loadBotFatherEditInfo', async (global, actions, payload): Promise<void> => {
  const { tabId = getCurrentTabId() } = payload || {};
  const modal = selectTabState(global, tabId).botFatherModal;
  const bot = modal?.selectedBotId ? selectUser(global, modal.selectedBotId) : undefined;
  if (!modal || !bot) return;

  global = updateTabState(global, {
    botFatherModal: {
      ...modal,
      isSaving: true,
      view: 'editInfo',
    },
  }, tabId);
  setGlobal(global);

  global = getGlobal();
  const langCode = selectSharedSettings(global).language;
  const info = await callApi('fetchBotInfo', { bot, langCode });
  global = getGlobal();
  const fullInfo = selectUserFullInfo(global, bot.id);

  global = getGlobal();
  const currentModal = selectTabState(global, tabId).botFatherModal;
  if (!currentModal) return;

  global = updateTabState(global, {
    botFatherModal: {
      ...currentModal,
      isSaving: undefined,
      editName: info?.name || bot.firstName || '',
      editAbout: info?.about || fullInfo?.bio || '',
      editDescription: info?.description || '',
    },
  }, tabId);
  setGlobal(global);
});

addActionHandler('saveBotFatherEditInfo', async (global, actions, payload): Promise<void> => {
  const {
    name, about, description, photo, tabId = getCurrentTabId(),
  } = payload;
  const modal = selectTabState(global, tabId).botFatherModal;
  const bot = modal?.selectedBotId ? selectUser(global, modal.selectedBotId) : undefined;
  if (!modal || !bot) return;

  global = updateTabState(global, {
    botFatherModal: {
      ...modal,
      isSaving: true,
    },
  }, tabId);
  setGlobal(global);

  const token = await callApi('exportBotToken', { bot, revoke: false, botUsername: getMainUsername(bot) });
  global = getGlobal();
  const langCode = selectSharedSettings(global).language;
  await callApi('setBotInfo', {
    bot,
    langCode,
    name: name.trim() || undefined,
    about: about?.trim() || undefined,
    description: description?.trim() || undefined,
    token,
  });

  global = getGlobal();
  if (about?.trim()) {
    global = updateUserFullInfo(global, bot.id, { bio: about.trim() });
  }
  if (name.trim()) {
    global = updateUser(global, bot.id, { firstName: name.trim() });
  }

  if (photo) {
    actions.uploadProfilePhoto({
      file: photo,
      bot,
      tabId,
    });
  }

  const currentModal = selectTabState(global, tabId).botFatherModal;
  if (!currentModal) {
    setGlobal(global);
    return;
  }

  global = updateTabState(global, {
    botFatherModal: {
      ...currentModal,
      isSaving: undefined,
      view: 'manage',
    },
  }, tabId);
  setGlobal(global);

  actions.showNotification({
    message: { key: 'BotFatherInfoUpdated' },
    tabId,
  });
});

addActionHandler('createBotViaBotFather', async (global, actions, payload): Promise<void> => {
  const {
    name, username, about, description, photo, tabId = getCurrentTabId(),
  } = payload;

  const modal = selectTabState(global, tabId).botFatherModal;
  if (!modal) return;

  global = updateTabState(global, {
    botFatherModal: {
      ...modal,
      isCreating: true,
      createError: undefined,
    },
  }, tabId);
  setGlobal(global);

  const currentChat = selectCurrentChat(global, tabId);
  const managerBot = selectUser(global, MANAGER_BOT_USER_ID)
    || (currentChat?.id === MANAGER_BOT_USER_ID ? selectUser(global, MANAGER_BOT_USER_ID) : undefined);
  if (managerBot?.accessHash) {
    try {
      localStorage.setItem('tt-manager-bot-access-hash', managerBot.accessHash);
    } catch {
      // ignore
    }
  }

  const result = await callApi('createBot', { name, username, managerBot });

  global = getGlobal();
  const currentModal = selectTabState(global, tabId).botFatherModal;
  if (!currentModal) return;

  if (!result || 'error' in result || !('user' in result)) {
    global = updateTabState(global, {
      botFatherModal: {
        ...currentModal,
        isCreating: undefined,
        createError: (result && 'error' in result && result.error) || 'BotFatherCreateError',
      },
    }, tabId);
    setGlobal(global);
    return;
  }

  const { user: bot, userStatusesById } = result;
  global = addUsers(global, buildCollectionByKey([bot], 'id'));
  if (userStatusesById) {
    global = addUserStatuses(global, userStatusesById);
  }
  setGlobal(global);

  const langCode = selectSharedSettings(global).language;
  const trimmedAbout = about?.trim();
  const trimmedDescription = description?.trim();
  if (trimmedAbout || trimmedDescription) {
    await callApi('setBotInfo', {
      bot,
      langCode,
      about: trimmedAbout,
      description: trimmedDescription,
    });
    global = getGlobal();
    if (trimmedAbout) {
      global = updateUserFullInfo(global, bot.id, { bio: trimmedAbout });
    }
    setGlobal(global);
  }

  if (photo) {
    actions.uploadProfilePhoto({
      file: photo,
      bot,
      tabId,
    });
  }

  const cleanUsername = username
    .replace(/^@/, '')
    .replace(/^t\.me\//i, '')
    .replace(/^https?:\/\/t\.me\//i, '')
    .trim();

  const token = await callApi('exportBotToken', {
    bot,
    revoke: false,
    botUsername: cleanUsername,
  });
  if (token) {
    storeBotToken(bot.id, token);
  }

  global = getGlobal();
  const latestModal = selectTabState(global, tabId).botFatherModal;
  if (!latestModal) return;

  const adminedBotIds = [...(latestModal.adminedBotIds || [])];
  if (!adminedBotIds.includes(bot.id)) {
    adminedBotIds.unshift(bot.id);
  }

  global = updateTabState(global, {
    botFatherModal: {
      ...latestModal,
      isCreating: undefined,
      view: 'manage',
      selectedBotId: bot.id,
      adminedBotIds,
      botToken: token,
      isLoadingToken: !token,
    },
  }, tabId);
  setGlobal(global);

  if (!token) {
    actions.loadBotFatherBotToken({ tabId });
  }

  actions.showNotification({
    message: { key: 'BotFatherCreateSuccess' },
    tabId,
  });
  actions.loadFullUser({ userId: bot.id });
});

function extractMainAppDisplayUrl(webViewUrl: string) {
  try {
    const parsed = new URL(webViewUrl);
    const keysToDelete: string[] = [];
    parsed.searchParams.forEach((_value, key) => {
      if (key.startsWith('tgWebApp')) {
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach((key) => parsed.searchParams.delete(key));
    if (parsed.hash.toLowerCase().includes('tgwebapp')) {
      parsed.hash = '';
    }

    let cleaned = parsed.toString();
    if (cleaned.endsWith('?')) {
      cleaned = cleaned.slice(0, -1);
    }
    return cleaned;
  } catch {
    return webViewUrl;
  }
}

type BotFatherMainAppCache = {
  url?: string;
  launchMode?: 'compact' | 'fullsize' | 'fullscreen';
};

const BOT_FATHER_MAIN_APP_STORAGE_KEY_PREFIX = 'botfather_main_app_';

function getStoredMainAppSettings(botId: string): BotFatherMainAppCache {
  try {
    const raw = localStorage.getItem(`${BOT_FATHER_MAIN_APP_STORAGE_KEY_PREFIX}${botId}`);
    return raw ? (JSON.parse(raw) as BotFatherMainAppCache) : {};
  } catch {
    return {};
  }
}

function saveStoredMainAppSettings(botId: string, settings: BotFatherMainAppCache) {
  try {
    if (!settings.url) {
      localStorage.removeItem(`${BOT_FATHER_MAIN_APP_STORAGE_KEY_PREFIX}${botId}`);
      return;
    }
    localStorage.setItem(`${BOT_FATHER_MAIN_APP_STORAGE_KEY_PREFIX}${botId}`, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

async function fetchLiveMainAppSettings(botId: string): Promise<BotFatherMainAppCache | undefined> {
  const global = getGlobal();
  const bot = selectUser(global, botId);
  if (!bot?.hasMainMiniApp) return undefined;

  const theme = extractCurrentThemeParams();
  const result = await callApi('requestMainWebView', {
    bot,
    peer: bot,
    theme,
  });
  if (!result?.url) return undefined;

  const launchMode: BotFatherMainAppCache['launchMode'] = result.isFullscreen
    ? 'fullscreen'
    : (result.isFullsize ? 'fullsize' : 'compact');

  return {
    url: extractMainAppDisplayUrl(result.url),
    launchMode,
  };
}

function setBotFatherMiniAppSaving(tabId: number, isSavingMiniApp?: true) {
  let global = getGlobal();
  const modal = selectTabState(global, tabId).botFatherModal;
  if (!modal) return;

  global = updateTabState(global, {
    botFatherModal: {
      ...modal,
      isSavingMiniApp,
    },
  }, tabId);
  setGlobal(global);
}

addActionHandler('saveBotFatherMenuButton', async (global, actions, payload): Promise<void> => {
  const { url, text, tabId = getCurrentTabId() } = payload;
  const modal = selectTabState(global, tabId).botFatherModal;
  if (!modal?.selectedBotId || !url.trim()) return;

  setBotFatherMiniAppSaving(tabId, true);

  global = getGlobal();
  const bot = selectUser(global, modal.selectedBotId);
  const botUsername = bot ? getMainUsername(bot) : undefined;
  let ok: true | undefined;
  try {
    const menuToken = bot ? await callApi('exportBotToken', { bot, revoke: false, botUsername }) : undefined;
    ok = menuToken
      ? await callApi('setBotMenuButtonViaApi', { token: menuToken, url: url.trim(), text: text?.trim() })
      : undefined;
  } finally {
    setBotFatherMiniAppSaving(tabId);
  }

  if (!ok) {
    actions.showNotification({
      message: { key: 'BotFatherAutomationError' },
      tabId,
    });
    return;
  }

  // Optimistic update: patch menuButton immediately so UI reflects the new values
  // on return without waiting for loadFullUser to propagate.
  global = getGlobal();
  const savedFullInfo = selectUserFullInfo(global, modal.selectedBotId);
  if (savedFullInfo?.botInfo) {
    global = updateUserFullInfo(global, modal.selectedBotId, {
      botInfo: {
        ...savedFullInfo.botInfo,
        menuButton: { type: 'webApp', text: text?.trim() || 'Open', url: url.trim() },
      },
    });
    setGlobal(global);
  }

  actions.loadFullUser({ userId: modal.selectedBotId });
  actions.setBotFatherModalView({ view: 'miniApps', tabId });
  actions.showNotification({
    message: { key: 'BotFatherInfoUpdated' },
    tabId,
  });
});

addActionHandler('disableBotFatherMenuButton', async (global, actions, payload): Promise<void> => {
  const { tabId = getCurrentTabId() } = payload || {};
  const modal = selectTabState(global, tabId).botFatherModal;
  if (!modal?.selectedBotId) return;

  setBotFatherMiniAppSaving(tabId, true);

  global = getGlobal();
  const bot = selectUser(global, modal.selectedBotId);
  const botUsername = bot ? getMainUsername(bot) : undefined;
  let ok: true | undefined;
  try {
    const disableToken = bot ? await callApi('exportBotToken', { bot, revoke: false, botUsername }) : undefined;
    ok = disableToken
      ? await callApi('setBotMenuButtonViaApi', { token: disableToken })
      : undefined;
  } finally {
    setBotFatherMiniAppSaving(tabId);
  }

  if (!ok) {
    actions.showNotification({
      message: { key: 'BotFatherAutomationError' },
      tabId,
    });
    return;
  }

  // Optimistic update: clear the webApp button so the hub shows it as disabled.
  global = getGlobal();
  const disabledFullInfo = selectUserFullInfo(global, modal.selectedBotId);
  if (disabledFullInfo?.botInfo) {
    global = updateUserFullInfo(global, modal.selectedBotId, {
      botInfo: {
        ...disabledFullInfo.botInfo,
        menuButton: { type: 'commands' },
      },
    });
    setGlobal(global);
  }

  actions.loadFullUser({ userId: modal.selectedBotId });
  actions.setBotFatherModalView({ view: 'miniApps', tabId });
  actions.showNotification({
    message: { key: 'BotFatherInfoUpdated' },
    tabId,
  });
});

addActionHandler('saveBotFatherMainApp', (global, actions, payload): ActionReturnType => {
  const { url, launchMode, tabId = getCurrentTabId() } = payload;
  const modal = selectTabState(global, tabId).botFatherModal;
  if (!modal?.selectedBotId || !url.trim()) return;

  saveStoredMainAppSettings(modal.selectedBotId, {
    url: url.trim(),
    launchMode,
  });

  global = getGlobal();
  const currentModal = selectTabState(global, tabId).botFatherModal;
  if (currentModal) {
    global = updateTabState(global, {
      botFatherModal: {
        ...currentModal,
        mainAppUrl: url.trim(),
        mainAppLaunchMode: launchMode,
      },
    }, tabId);
    setGlobal(global);
  }

  actions.loadFullUser({ userId: modal.selectedBotId });
  actions.setBotFatherModalView({ view: 'miniApps', tabId });
  actions.showNotification({
    message: { key: 'BotFatherInfoUpdated' },
    tabId,
  });
});

addActionHandler('disableBotFatherMainApp', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};
  const modal = selectTabState(global, tabId).botFatherModal;
  if (!modal?.selectedBotId) return;

  saveStoredMainAppSettings(modal.selectedBotId, {});

  global = getGlobal();
  const currentModal = selectTabState(global, tabId).botFatherModal;
  if (currentModal) {
    global = updateTabState(global, {
      botFatherModal: {
        ...currentModal,
        mainAppUrl: undefined,
        mainAppLaunchMode: undefined,
      },
    }, tabId);
    setGlobal(global);
  }

  actions.loadFullUser({ userId: modal.selectedBotId });
  actions.setBotFatherModalView({ view: 'miniApps', tabId });
  actions.showNotification({
    message: { key: 'BotFatherInfoUpdated' },
    tabId,
  });
});

addActionHandler('loadBotFatherMainApp', async (global, actions, payload): Promise<void> => {
  const { tabId = getCurrentTabId() } = payload || {};
  const modal = selectTabState(global, tabId).botFatherModal;
  if (!modal?.selectedBotId) return;

  const botId = modal.selectedBotId;
  const cached = getStoredMainAppSettings(botId);

  global = updateTabState(global, {
    botFatherModal: {
      ...modal,
      mainAppUrl: cached.url || modal.mainAppUrl,
      mainAppLaunchMode: cached.launchMode || modal.mainAppLaunchMode || 'compact',
    },
  }, tabId);
  setGlobal(global);

  const live = await fetchLiveMainAppSettings(botId);
  if (!live?.url) return;

  saveStoredMainAppSettings(botId, {
    url: live.url,
    launchMode: live.launchMode || cached.launchMode || 'compact',
  });

  global = getGlobal();
  const currentModal = selectTabState(global, tabId).botFatherModal;
  if (!currentModal || currentModal.view !== 'miniAppMainApp') return;

  global = updateTabState(global, {
    botFatherModal: {
      ...currentModal,
      mainAppUrl: live.url,
      mainAppLaunchMode: live.launchMode || currentModal.mainAppLaunchMode || 'compact',
    },
  }, tabId);
  setGlobal(global);
});

addActionHandler('createBotFatherDirectLink', (global, actions, payload): ActionReturnType => {
  const {
    shortName, tabId = getCurrentTabId(),
  } = payload;
  const modal = selectTabState(global, tabId).botFatherModal;
  if (!modal?.selectedBotId || !shortName.trim()) return global;

  rememberDirectLinkShortName(modal.selectedBotId, shortName.trim().toLowerCase());

  actions.setBotFatherModalView({
    view: 'miniApps',
    editingDirectLinkShortName: undefined,
    tabId,
  });
  actions.loadBotFatherDirectLinks({ tabId });
  actions.showNotification({
    message: { key: 'BotFatherInfoUpdated' },
    tabId,
  });
  return global;
});

addActionHandler('deleteBotFatherDirectLink', (global, actions, payload): ActionReturnType => {
  const { shortName, tabId = getCurrentTabId() } = payload;
  const modal = selectTabState(global, tabId).botFatherModal;
  if (!modal?.selectedBotId || !shortName.trim()) return global;

  forgetDirectLinkShortName(modal.selectedBotId, shortName);
  actions.loadBotFatherDirectLinks({ tabId });
  actions.showNotification({
    message: { key: 'BotFatherInfoUpdated' },
    tabId,
  });
  return global;
});

const BOT_FATHER_APPS_STORAGE_KEY_PREFIX = 'botfather_direct_links_';

function getStoredDirectLinkShortNames(botId: string): string[] {
  try {
    const raw = localStorage.getItem(`${BOT_FATHER_APPS_STORAGE_KEY_PREFIX}${botId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<{ shortName?: string } | string>;
    return parsed
      .map((item) => (typeof item === 'string' ? item : item.shortName))
      .filter((name): name is string => Boolean(name))
      .map((name) => name.toLowerCase());
  } catch {
    return [];
  }
}

function saveStoredDirectLinkShortNames(botId: string, shortNames: string[]) {
  try {
    const unique = Array.from(new Set(shortNames.map((name) => name.toLowerCase())));
    localStorage.setItem(
      `${BOT_FATHER_APPS_STORAGE_KEY_PREFIX}${botId}`,
      JSON.stringify(unique.map((shortName) => ({ shortName }))),
    );
  } catch {
    // ignore
  }
}

function rememberDirectLinkShortName(botId: string, shortName: string) {
  const existing = getStoredDirectLinkShortNames(botId);
  saveStoredDirectLinkShortNames(botId, [shortName, ...existing]);
}

function forgetDirectLinkShortName(botId: string, shortName: string) {
  const existing = getStoredDirectLinkShortNames(botId);
  saveStoredDirectLinkShortNames(
    botId,
    existing.filter((name) => name !== shortName.toLowerCase()),
  );
}

addActionHandler('loadBotFatherDirectLinks', async (global, actions, payload): Promise<void> => {
  const { tabId = getCurrentTabId() } = payload || {};
  const modal = selectTabState(global, tabId).botFatherModal;
  if (!modal?.selectedBotId) return;

  const botId = modal.selectedBotId;
  const bot = selectUser(global, botId);
  if (!bot) return;

  const cachedNames = getStoredDirectLinkShortNames(botId);
  const candidates = Array.from(new Set([
    ...cachedNames,
    'app',
    'main',
    'testing',
  ]));

  const links: Array<{
    shortName: string;
    title: string;
    description?: string;
  }> = [];

  for (const shortName of candidates) {
    try {
      const appRes = await callApi('fetchBotApp', { bot, appName: shortName });
      if (appRes) {
        links.push({
          shortName: appRes.shortName || shortName,
          title: appRes.title || shortName,
          description: appRes.description || undefined,
        });
      }
    } catch {
      // App not found for this short name
    }
  }

  saveStoredDirectLinkShortNames(botId, links.map((link) => link.shortName));

  global = getGlobal();
  const currentModal = selectTabState(global, tabId).botFatherModal;
  if (!currentModal) return;

  global = updateTabState(global, {
    botFatherModal: {
      ...currentModal,
      directLinks: links,
    },
  }, tabId);
  setGlobal(global);
});

addActionHandler('saveBotFatherCommands', async (global, actions, payload): Promise<void> => {
  const { commands, tabId = getCurrentTabId() } = payload;
  const modal = selectTabState(global, tabId).botFatherModal;
  if (!modal?.selectedBotId) return;

  global = updateTabState(global, {
    botFatherModal: {
      ...modal,
      isSavingCommands: true,
    },
  }, tabId);
  setGlobal(global);

  global = getGlobal();
  const bot = selectUser(global, modal.selectedBotId);
  if (!bot) {
    global = updateTabState(global, {
      botFatherModal: {
        ...selectTabState(global, tabId).botFatherModal!,
        isSavingCommands: undefined,
      },
    }, tabId);
    setGlobal(global);
    actions.showNotification({
      message: { key: 'BotFatherCommandsError' },
      tabId,
    });
    return;
  }

  const langCode = selectSharedSettings(global).language;
  const token = await callApi('exportBotToken', { bot, revoke: false });
  if (!token) {
    global = getGlobal();
    const failedModal = selectTabState(global, tabId).botFatherModal;
    if (!failedModal) return;
    global = updateTabState(global, {
      botFatherModal: {
        ...failedModal,
        isSavingCommands: undefined,
      },
    }, tabId);
    setGlobal(global);
    actions.showNotification({
      message: { key: 'BotFatherCommandsError' },
      tabId,
    });
    return;
  }

  const normalizedCommands = commands
    .map(({ command, description }) => ({
      command: command.trim().replace(/^\//, '').toLowerCase(),
      description: description.trim(),
    }))
    .filter(({ command, description }) => command && description);

  const ok = normalizedCommands.length
    ? await callApi('setBotCommands', {
      token,
      langCode,
      commands: normalizedCommands,
    })
    : await callApi('resetBotCommands', { token, langCode });

  global = getGlobal();
  const currentModal = selectTabState(global, tabId).botFatherModal;
  if (!currentModal) return;

  global = updateTabState(global, {
    botFatherModal: {
      ...currentModal,
      isSavingCommands: undefined,
    },
  }, tabId);
  setGlobal(global);

  if (!ok) {
    actions.showNotification({
      message: { key: 'BotFatherCommandsError' },
      tabId,
    });
    return;
  }

  actions.loadFullUser({ userId: modal.selectedBotId });
  actions.setBotFatherModalView({ view: 'commands', tabId });
  actions.showNotification({
    message: { key: 'BotFatherCommandsSaved' },
    tabId,
  });
});

addActionHandler('deleteBotViaBotFather', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};
  const modal = selectTabState(global, tabId).botFatherModal;
  if (!modal?.selectedBotId) return global;

  const botId = modal.selectedBotId;
  const remainingIds = (modal.adminedBotIds || []).filter((id) => id !== botId);

  global = updateTabState(global, {
    botFatherModal: {
      ...modal,
      view: 'home',
      selectedBotId: undefined,
      botToken: undefined,
      isDeletingBot: undefined,
      adminedBotIds: remainingIds,
    },
  }, tabId);

  actions.showNotification({
    message: { key: 'BotFatherDeleteSuccess' },
    tabId,
  });
  actions.loadAdminedBots({ tabId });
  return global;
});

addActionHandler('runBotFatherManageCommand', (global, actions, payload): ActionReturnType => {
  const { command } = payload;
  const cleanCommand = command.replace(/^\//, '').toLowerCase();
  window.open(`https://t.me/BotFather?start=${cleanCommand}`, '_blank', 'noopener');
  return global;
});

addActionHandler('startBotFatherConversation', (global, actions, payload): ActionReturnType => {
  const {
    tabId = getCurrentTabId(),
  } = payload || {};

  actions.openChat({ id: MANAGER_BOT_USER_ID, tabId });
  return global;
});

addActionHandler('loadBotFreezeAppeal', async (global): Promise<void> => {
  const botUrl = global.appConfig.freezeAppealUrl;
  if (!botUrl) return;
  const botAppealUsername = botUrl ? getUsernameFromDeepLink(botUrl) : undefined;
  if (!botAppealUsername) return;
  const chat = await fetchChatByUsername(global, botAppealUsername);
  global = getGlobal();
  global = {
    ...global,
    botFreezeAppealId: chat?.id,
  };
  setGlobal(global);
});
