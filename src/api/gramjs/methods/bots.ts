import { Api as GramJs, sessions } from '../../../lib/gramjs';
import TelegramClient from '../../../lib/gramjs/client/TelegramClient';
import { RPCError } from '../../../lib/gramjs/errors';
import { generateRandomBigInt, sleep } from '../../../lib/gramjs/Helpers';

import type {
  ApiBotApp,
  ApiBotPreviewMedia,
  ApiChat,
  ApiInputMessageReplyInfo,
  ApiPeer,
  ApiThemeParameters,
  ApiUrlAuthResult,
  ApiUser,
} from '../../types';

import {
  LANG_PACK,
  MANAGER_BOT_ACCESS_HASH,
  MANAGER_BOT_TOKEN,
  MANAGER_BOT_USER_ID,
  TELEGRAM_API_HASH,
  TELEGRAM_API_ID,
  WEB_APP_PLATFORM,
} from '../../../config';
import { buildCollectionByKey } from '../../../util/iteratees';
import { getMtpEphemeralMessageId } from '../../../util/keys/messageKey';
import {
  buildApiAttachBot,
  buildApiBotInlineMediaResult,
  buildApiBotInlineResult,
  buildApiMessagesBotApp,
  buildBotSwitchPm,
  buildBotSwitchWebview,
} from '../apiBuilders/bots';
import { omitVirtualClassFields } from '../apiBuilders/helpers';
import { buildMessageMediaContent } from '../apiBuilders/messageContent';
import { buildApiUrlAuthResult } from '../apiBuilders/misc';
import { buildApiUser, buildApiUserStatuses } from '../apiBuilders/users';
import {
  buildInputBotApp,
  buildInputPeer,
  buildInputReplyTo,
  buildInputThemeParams,
  buildInputUser,
  DEFAULT_PRIMITIVES,
} from '../gramjsBuilders';
import {
  addDocumentToLocalDb,
  addPhotoToLocalDb,
  addUserToLocalDb,
  addWebDocumentToLocalDb,
} from '../helpers/localDb';
import { deserializeBytes } from '../helpers/misc';
import { sendApiUpdate } from '../updates/apiUpdateEmitter';
import { getClient, invokeRequest } from './client';

const BOT_API_BASE_URL = 'https://api.telegram.org/bot';

export async function answerCallbackButton({
  chatId, accessHash, messageId, data, isGame,
}: {
  chatId: string; accessHash?: string; messageId: number; data?: string; isGame?: boolean;
}) {
  const result = await invokeRequest(new GramJs.messages.GetBotCallbackAnswer({
    peer: buildInputPeer(chatId, accessHash),
    msgId: messageId,
    data: data ? deserializeBytes(data) : undefined,
    game: isGame || undefined,
  }));

  return result ? omitVirtualClassFields(result) : undefined;
}

export async function answerEphemeralCallbackButton({
  chat, messageId, data,
}: {
  chat: ApiChat; messageId: number; data?: string;
}) {
  const result = await invokeRequest(new GramJs.ephemeral.GetCallbackAnswer({
    peer: buildInputPeer(chat.id, chat.accessHash),
    id: getMtpEphemeralMessageId(messageId),
    data: data ? deserializeBytes(data) : undefined,
  }));

  return result ? omitVirtualClassFields(result) : undefined;
}

export async function fetchInlineBotResults({
  bot, chat, query, offset = DEFAULT_PRIMITIVES.STRING,
}: {
  bot: ApiUser; chat: ApiChat; query: string; offset?: string;
}) {
  const result = await invokeRequest(new GramJs.messages.GetInlineBotResults({
    bot: buildInputUser(bot.id, bot.accessHash),
    peer: buildInputPeer(chat.id, chat.accessHash),
    query,
    offset,
  }));

  if (!result) {
    return undefined;
  }

  return {
    isGallery: Boolean(result.gallery),
    help: bot.botPlaceholder,
    nextOffset: getInlineBotResultsNextOffset(bot.usernames![0].username, result.nextOffset),
    switchPm: buildBotSwitchPm(result.switchPm),
    switchWebview: buildBotSwitchWebview(result.switchWebview),
    results: processInlineBotResult(String(result.queryId), result.results),
    cacheTime: result.cacheTime,
  };
}

export async function sendInlineBotResult({
  chat, replyInfo, resultId, queryId, sendAs, isSilent, scheduleDate, allowPaidStars,
}: {
  chat: ApiChat;
  replyInfo?: ApiInputMessageReplyInfo;
  resultId: string;
  queryId: string;
  sendAs?: ApiPeer;
  isSilent?: boolean;
  scheduleDate?: number;
  allowPaidStars?: number;
}) {
  const randomId = generateRandomBigInt();

  await invokeRequest(new GramJs.messages.SendInlineBotResult({
    clearDraft: true,
    randomId,
    queryId: BigInt(queryId),
    peer: buildInputPeer(chat.id, chat.accessHash),
    id: resultId,
    scheduleDate,
    replyTo: replyInfo && buildInputReplyTo(replyInfo),
    ...(isSilent && { silent: true }),
    ...(sendAs && { sendAs: buildInputPeer(sendAs.id, sendAs.accessHash) }),
    ...(allowPaidStars && { allowPaidStars: BigInt(allowPaidStars) }),
  }));
}

export async function startBot({
  bot, peer = bot, startParam,
}: {
  bot: ApiUser;
  peer?: ApiPeer;
  startParam?: string;
}) {
  const randomId = generateRandomBigInt();

  return invokeRequest(new GramJs.messages.StartBot({
    bot: buildInputUser(bot.id, bot.accessHash),
    peer: buildInputPeer(peer.id, peer.accessHash),
    randomId,
    startParam: startParam ?? DEFAULT_PRIMITIVES.STRING,
  }), {
    shouldReturnTrue: true,
  });
}

export async function requestWebView({
  isSilent,
  peer,
  bot,
  url,
  startParam,
  replyInfo,
  theme,
  sendAs,
  isFromBotMenu,
  isFullscreen,
}: {
  isSilent?: boolean;
  peer: ApiPeer;
  bot: ApiUser;
  url?: string;
  startParam?: string;
  replyInfo?: ApiInputMessageReplyInfo;
  theme?: ApiThemeParameters;
  sendAs?: ApiPeer;
  isFromBotMenu?: boolean;
  isFullscreen?: boolean;
}) {
  const result = await invokeRequest(new GramJs.messages.RequestWebView({
    silent: isSilent || undefined,
    peer: buildInputPeer(peer.id, peer.accessHash),
    bot: buildInputUser(bot.id, bot.accessHash),
    url,
    startParam,
    themeParams: theme ? buildInputThemeParams(theme) : undefined,
    fromBotMenu: isFromBotMenu || undefined,
    platform: WEB_APP_PLATFORM,
    replyTo: replyInfo && buildInputReplyTo(replyInfo),
    fullscreen: isFullscreen ? true : undefined,
    ...(sendAs && { sendAs: buildInputPeer(sendAs.id, sendAs.accessHash) }),
  }));

  if (result instanceof GramJs.WebViewResultUrl) {
    return {
      url: result.url,
      queryId: result.queryId?.toString(),
      isFullScreen: Boolean(result.fullscreen),
      isSameOrigin: result.sameOrigin,
    };
  }

  return undefined;
}

export async function requestMainWebView({
  peer,
  bot,
  startParam,
  mode,
  theme,
}: {
  peer: ApiPeer;
  bot: ApiUser;
  startParam?: string;
  mode?: string;
  theme?: ApiThemeParameters;
}) {
  const result = await invokeRequest(new GramJs.messages.RequestMainWebView({
    peer: buildInputPeer(peer.id, peer.accessHash),
    bot: buildInputUser(bot.id, bot.accessHash),
    startParam,
    fullscreen: mode === 'fullscreen' || undefined,
    themeParams: theme ? buildInputThemeParams(theme) : undefined,
    platform: WEB_APP_PLATFORM,
  }));

  if (!(result instanceof GramJs.WebViewResultUrl)) {
    return undefined;
  }

  return {
    url: result.url,
    queryId: result.queryId?.toString(),
    isFullscreen: Boolean(result.fullscreen),
    isFullsize: Boolean(result.fullsize),
    isSameOrigin: result.sameOrigin,
  };
}

export async function requestSimpleWebView({
  bot,
  url,
  theme,
  startParam,
  isFromSwitchWebView,
  isFromSideMenu,
}: {
  bot: ApiUser;
  url?: string;
  theme?: ApiThemeParameters;
  startParam?: string;
  isFromSwitchWebView?: boolean;
  isFromSideMenu?: boolean;
}) {
  const result = await invokeRequest(new GramJs.messages.RequestSimpleWebView({
    url,
    bot: buildInputUser(bot.id, bot.accessHash),
    themeParams: theme ? buildInputThemeParams(theme) : undefined,
    platform: WEB_APP_PLATFORM,
    startParam,
    fromSwitchWebview: isFromSwitchWebView || undefined,
    fromSideMenu: isFromSideMenu || undefined,
  }));

  if (!(result instanceof GramJs.WebViewResultUrl)) {
    return undefined;
  }

  return {
    url: result.url,
    isSameOrigin: result.sameOrigin,
  };
}

export async function fetchBotApp({
  bot,
  appName,
}: {
  bot: ApiUser;
  appName: string;
}) {
  const result = await invokeRequest(new GramJs.messages.GetBotApp({
    app: new GramJs.InputBotAppShortName({
      botId: buildInputUser(bot.id, bot.accessHash),
      shortName: appName,
    }),
    hash: DEFAULT_PRIMITIVES.BIGINT,
  }));

  if (!result || result instanceof GramJs.BotAppNotModified) {
    return undefined;
  }

  return buildApiMessagesBotApp(result);
}

export async function requestAppWebView({
  peer,
  app,
  startParam,
  mode,
  theme,
  isWriteAllowed,
}: {
  peer: ApiPeer;
  app: ApiBotApp;
  startParam?: string;
  mode?: string;
  theme?: ApiThemeParameters;
  isWriteAllowed?: boolean;
}) {
  const result = await invokeRequest(new GramJs.messages.RequestAppWebView({
    peer: buildInputPeer(peer.id, peer.accessHash),
    app: buildInputBotApp(app),
    startParam,
    themeParams: theme ? buildInputThemeParams(theme) : undefined,
    platform: WEB_APP_PLATFORM,
    writeAllowed: isWriteAllowed || undefined,
    fullscreen: mode === 'fullscreen' || undefined,
  }));

  if (!(result instanceof GramJs.WebViewResultUrl)) {
    return undefined;
  }

  return {
    url: result.url,
    isFullscreen: Boolean(result.fullscreen),
    isSameOrigin: result.sameOrigin,
  };
}

export function prolongWebView({
  isSilent,
  peer,
  bot,
  queryId,
  replyInfo,
  sendAs,
}: {
  isSilent?: boolean;
  peer: ApiPeer;
  bot: ApiUser;
  queryId: string;
  replyInfo?: ApiInputMessageReplyInfo;
  sendAs?: ApiPeer;
}) {
  return invokeRequest(new GramJs.messages.ProlongWebView({
    silent: isSilent || undefined,
    peer: buildInputPeer(peer.id, peer.accessHash),
    bot: buildInputUser(bot.id, bot.accessHash),
    queryId: BigInt(queryId),
    replyTo: replyInfo && buildInputReplyTo(replyInfo),
    ...(sendAs && { sendAs: buildInputPeer(sendAs.id, sendAs.accessHash) }),
  }));
}

export async function sendWebViewData({
  bot, buttonText, data,
}: {
  bot: ApiUser;
  buttonText: string;
  data: string;
}) {
  const randomId = generateRandomBigInt();
  await invokeRequest(new GramJs.messages.SendWebViewData({
    bot: buildInputUser(bot.id, bot.accessHash),
    buttonText,
    data,
    randomId,
  }));
}

export async function loadAttachBots({
  hash,
}: {
  hash?: string;
}) {
  const result = await invokeRequest(new GramJs.messages.GetAttachMenuBots({
    hash: hash ? BigInt(hash) : DEFAULT_PRIMITIVES.BIGINT,
  }));

  if (result instanceof GramJs.AttachMenuBots) {
    return {
      hash: result.hash.toString(),
      bots: buildCollectionByKey(result.bots.map(buildApiAttachBot), 'id'),
    };
  }
  return undefined;
}

export async function loadAttachBot({
  bot,
}: {
  bot: ApiUser;
}) {
  const result = await invokeRequest(new GramJs.messages.GetAttachMenuBot({
    bot: buildInputUser(bot.id, bot.accessHash),
  }));

  if (result instanceof GramJs.AttachMenuBotsBot) {
    return {
      bot: buildApiAttachBot(result.bot),
    };
  }
  return undefined;
}

export function toggleAttachBot({
  bot,
  isWriteAllowed,
  isEnabled,
}: {
  bot: ApiUser;
  isWriteAllowed?: boolean;
  isEnabled: boolean;
}) {
  return invokeRequest(new GramJs.messages.ToggleBotInAttachMenu({
    bot: buildInputUser(bot.id, bot.accessHash),
    writeAllowed: isWriteAllowed || undefined,
    enabled: isEnabled,
  }));
}

export async function requestBotUrlAuth({
  chat, buttonId, messageId,
}: {
  chat: ApiChat;
  buttonId: number;
  messageId: number;
}) {
  return invokeUrlAuthRequest(new GramJs.messages.RequestUrlAuth({
    peer: buildInputPeer(chat.id, chat.accessHash),
    buttonId,
    msgId: messageId,
  }));
}

export async function acceptBotUrlAuth({
  chat,
  messageId,
  buttonId,
  isWriteAllowed,
  wasPhoneShared,
  matchCode,
}: {
  chat: ApiChat;
  messageId: number;
  buttonId: number;
  isWriteAllowed?: boolean;
  wasPhoneShared?: boolean;
  matchCode?: string;
}) {
  return invokeUrlAuthRequest(new GramJs.messages.AcceptUrlAuth({
    peer: buildInputPeer(chat.id, chat.accessHash),
    msgId: messageId,
    buttonId,
    writeAllowed: isWriteAllowed || undefined,
    sharePhoneNumber: wasPhoneShared || undefined,
    matchCode: matchCode || undefined,
  }));
}

export async function requestLinkUrlAuth({ url }: { url: string }) {
  return invokeUrlAuthRequest(new GramJs.messages.RequestUrlAuth({
    url,
  }));
}

export async function acceptLinkUrlAuth({
  url, isWriteAllowed, wasPhoneShared, matchCode,
}: {
  url: string;
  isWriteAllowed?: boolean;
  wasPhoneShared?: boolean;
  matchCode?: string;
}) {
  return invokeUrlAuthRequest(new GramJs.messages.AcceptUrlAuth({
    url,
    writeAllowed: isWriteAllowed || undefined,
    sharePhoneNumber: wasPhoneShared || undefined,
    matchCode: matchCode || undefined,
  }));
}

export async function checkUrlAuthMatchCode({ url, matchCode }: { url: string; matchCode: string }) {
  try {
    const result = await invokeRequest(new GramJs.messages.CheckUrlAuthMatchCode({
      url,
      matchCode,
    }), {
      shouldThrow: true,
    });
    if (!result) return { type: 'unmatched' };

    return { type: 'matched' };
  } catch (err) {
    if (err instanceof RPCError && err.errorMessage === 'URL_EXPIRED') {
      return { type: 'expired' };
    }
    throw err;
  }
}

export async function declineUrlAuth({ url }: { url: string }) {
  return invokeRequest(new GramJs.messages.DeclineUrlAuth({ url }), {
    shouldReturnTrue: true,
  });
}

export function fetchBotCanSendMessage({ bot }: { bot: ApiUser }) {
  return invokeRequest(new GramJs.bots.CanSendMessage({
    bot: buildInputUser(bot.id, bot.accessHash),
  }));
}

export function allowBotSendMessages({ bot }: { bot: ApiUser }) {
  return invokeRequest(new GramJs.bots.AllowSendMessage({
    bot: buildInputUser(bot.id, bot.accessHash),
  }), {
    shouldReturnTrue: true,
  });
}

export async function invokeWebViewCustomMethod({
  bot,
  customMethod,
  parameters,
}: {
  bot: ApiUser;
  customMethod: string;
  parameters: string;
}): Promise<{
  result: object;
} | {
  error: string;
}> {
  try {
    const result = await invokeRequest(new GramJs.bots.InvokeWebViewCustomMethod({
      bot: buildInputUser(bot.id, bot.accessHash),
      params: new GramJs.DataJSON({
        data: parameters,
      }),
      customMethod,
    }), {
      shouldThrow: true,
    });

    return {
      result: JSON.parse(result!.data),
    };
  } catch (e) {
    const error = e as Error;
    return {
      error: error.message,
    };
  }
}

export async function fetchPreviewMedias({ bot }: { bot: ApiUser }) {
  const result = await invokeRequest(new GramJs.bots.GetPreviewMedias({
    bot: buildInputUser(bot.id, bot.accessHash),
  }));

  if (!result) return undefined;

  const previews: ApiBotPreviewMedia[] = result.map((preview) => {
    return {
      content: buildMessageMediaContent(preview.media)!,
      date: preview.date,
    };
  });
  return previews;
}

export function checkBotDownloadFileParams({
  bot,
  fileName,
  url,
}: {
  bot: ApiUser;
  fileName: string;
  url: string;
}) {
  return invokeRequest(new GramJs.bots.CheckDownloadFileParams({
    bot: buildInputUser(bot.id, bot.accessHash),
    fileName,
    url,
  }), {
    shouldReturnTrue: true,
  });
}

export function toggleUserEmojiStatusPermission({ bot, isEnabled }: { bot: ApiUser; isEnabled: boolean }) {
  return invokeRequest(new GramJs.bots.ToggleUserEmojiStatusPermission({
    bot: buildInputUser(bot.id, bot.accessHash),
    enabled: isEnabled,
  }), {
    shouldReturnTrue: true,
  });
}

function processInlineBotResult(queryId: string, results: GramJs.TypeBotInlineResult[]) {
  return results.map((result) => {
    if (result instanceof GramJs.BotInlineMediaResult) {
      if (result.document instanceof GramJs.Document) {
        addDocumentToLocalDb(result.document);
      }

      if (result.photo instanceof GramJs.Photo) {
        addPhotoToLocalDb(result.photo);
      }

      return buildApiBotInlineMediaResult(result, queryId);
    }

    if (result.thumb) {
      addWebDocumentToLocalDb(result.thumb);
    }

    return buildApiBotInlineResult(result, queryId);
  });
}

function getInlineBotResultsNextOffset(username: string, nextOffset?: string) {
  return username === 'gif' && nextOffset === '0' ? '' : nextOffset;
}

export async function setBotInfo({
  bot,
  langCode,
  name,
  about,
  description,
  token,
}: {
  bot: ApiUser;
  langCode?: string;
  name?: string;
  about?: string;
  description?: string;
  token?: string;
}) {
  const botToken = token || exportedTokensByBotId.get(bot.id);
  if (botToken) {
    try {
      if (name !== undefined) {
        await fetch(`${BOT_API_BASE_URL}${botToken}/setMyName`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
      }
      if (description !== undefined) {
        await fetch(`${BOT_API_BASE_URL}${botToken}/setMyDescription`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description }),
        });
      }
      if (about !== undefined) {
        await fetch(`${BOT_API_BASE_URL}${botToken}/setMyShortDescription`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ short_description: about }),
        });
      }
    } catch {
      // ignore network errors
    }
  }

  const inputUser = buildInputUser(bot.id, bot.accessHash);
  await invokeRequest(new GramJs.bots.SetBotInfo({
    bot: inputUser,
    langCode: '',
    name,
    about,
    description,
  }), {
    shouldReturnTrue: true,
  });

  if (langCode) {
    await invokeRequest(new GramJs.bots.SetBotInfo({
      bot: inputUser,
      langCode,
      name,
      about,
      description,
    }), {
      shouldReturnTrue: true,
    });
  }

  return true;
}

export async function fetchBotInfo({
  bot,
  langCode,
}: {
  bot: ApiUser;
  langCode: string;
}) {
  const result = await invokeRequest(new GramJs.bots.GetBotInfo({
    bot: buildInputUser(bot.id, bot.accessHash),
    langCode,
  }));

  if (!result) return undefined;

  return {
    name: result.name,
    about: result.about,
    description: result.description,
  };
}

let managerBotClient: TelegramClient | undefined;
let managerBotPromise: Promise<TelegramClient | undefined> | undefined;

async function getManagerBotClient(): Promise<TelegramClient | undefined> {
  const botToken = MANAGER_BOT_TOKEN || '8849753612:AAFBvoKmcfrutOOaOv77oEfpf2BaOqB-ocg';
  if (!botToken) {
    // eslint-disable-next-line no-console
    console.warn('[getManagerBotClient] MANAGER_BOT_TOKEN is not configured');
    return undefined;
  }
  if (managerBotClient && managerBotClient.isConnected()) {
    return managerBotClient;
  }
  if (managerBotPromise) {
    return managerBotPromise;
  }

  managerBotPromise = (async () => {
    try {
      const session = new sessions.MemorySession();
      const mainClient = getClient();
      const mainDcId = mainClient?.session?.dcId;

      const botClient = new TelegramClient(
        session,
        TELEGRAM_API_ID,
        TELEGRAM_API_HASH || 'd5406d092759441df03353fde8f1fe86',
        {
          useWSS: true,
          langPack: LANG_PACK,
          dcId: mainDcId,
          deviceModel: 'BotBrotherManager',
          systemVersion: 'Web',
          appVersion: '1.0.0',
        },
      );

      if (!botClient.isConnected()) {
        await botClient.connect();
      }

      const authResult = await botClient.invoke(new GramJs.auth.ImportBotAuthorization({
        apiId: TELEGRAM_API_ID,
        apiHash: TELEGRAM_API_HASH || 'd5406d092759441df03353fde8f1fe86',
        botAuthToken: botToken,
      }));
      // eslint-disable-next-line no-console
      console.log('[getManagerBotClient] Manager bot MTProto authorized successfully:', authResult);

      const rawUpdateEventBuilder = { build: (update: any) => update };
      botClient.addEventHandler((update: any) => {
        if (update?.users && Array.isArray(update.users)) {
          for (const u of update.users) {
            if (u && 'id' in u && 'accessHash' in u && u.accessHash) {
              managerSessionAccessHashes.set(u.id.toString(), BigInt(u.accessHash));
            }
          }
        }
      }, rawUpdateEventBuilder);

      managerBotClient = botClient;
      return botClient;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to initialize Manager Bot MTProto client:', err);
      managerBotClient = undefined;
      return undefined;
    } finally {
      managerBotPromise = undefined;
    }
  })();

  return managerBotPromise;
}

const exportedTokensByBotId = new Map<string, string>();
const managerSessionAccessHashes = new Map<string, bigint>();

async function getManagerInputUser(
  managerClient: TelegramClient,
  botId: string,
  username?: string,
): Promise<GramJs.InputUser | undefined> {
  // 1. Check cached manager session access hash
  if (managerSessionAccessHashes.has(botId)) {
    return new GramJs.InputUser({
      userId: BigInt(botId),
      accessHash: managerSessionAccessHashes.get(botId)!,
    });
  }

  // 2. Try resolving by username
  if (username) {
    const cleanUsername = username
      .replace(/^@/, '')
      .replace(/^t\.me\//i, '')
      .replace(/^https?:\/\/t\.me\//i, '')
      .trim();

    if (cleanUsername) {
      try {
        // eslint-disable-next-line no-console
        console.log('[getManagerInputUser] Resolving bot username:', cleanUsername);
        const resolved = await managerClient.invoke(new GramJs.contacts.ResolveUsername({
          username: cleanUsername,
        }));
        if (resolved?.users && Array.isArray(resolved.users) && resolved.users.length) {
          for (const u of resolved.users) {
            if (u && 'id' in u && 'accessHash' in u && u.accessHash) {
              managerSessionAccessHashes.set(u.id.toString(), BigInt(u.accessHash));
            }
          }
          const matchedUser = resolved.users.find((u: any) => u.id?.toString() === botId) || resolved.users[0];
          if (matchedUser && 'id' in matchedUser && 'accessHash' in matchedUser && matchedUser.accessHash) {
            return new GramJs.InputUser({
              userId: BigInt(matchedUser.id),
              accessHash: BigInt(matchedUser.accessHash),
            });
          }
        }
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.warn('[exportBotToken] Manager contacts.ResolveUsername failed:', err?.errorMessage || err);
      }
    }
  }

  // 3. Try bots.GetAdminedBots on managerClient
  try {
    const admined = await managerClient.invoke(new GramJs.bots.GetAdminedBots());
    if (Array.isArray(admined)) {
      for (const u of admined) {
        if (u && 'id' in u && 'accessHash' in u && u.accessHash) {
          managerSessionAccessHashes.set(u.id.toString(), BigInt(u.accessHash));
        }
      }
      const matched = admined.find((u: any) => u.id?.toString() === botId);
      if (matched && 'id' in matched && 'accessHash' in matched && matched.accessHash) {
        return new GramJs.InputUser({
          userId: BigInt(matched.id),
          accessHash: BigInt(matched.accessHash),
        });
      }
    }
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.warn('[exportBotToken] Manager bots.GetAdminedBots failed:', err?.errorMessage || err);
  }

  return undefined;
}

export async function exportBotToken({
  bot,
  revoke,
  botUsername,
}: {
  bot: ApiUser;
  revoke: boolean;
  botUsername?: string;
}) {
  if (bot.id === MANAGER_BOT_USER_ID) {
    if (MANAGER_BOT_TOKEN) {
      exportedTokensByBotId.set(bot.id, MANAGER_BOT_TOKEN);
    }
    return MANAGER_BOT_TOKEN;
  }

  if (revoke) {
    exportedTokensByBotId.delete(bot.id);
  } else if (exportedTokensByBotId.has(bot.id)) {
    return exportedTokensByBotId.get(bot.id);
  }

  // Telegram requires manager bot MTProto session (bots.exportBotToken requires USER_BOT_REQUIRED)

  // 2. Try via manager bot MTProto client
  try {
    const managerClient = await getManagerBotClient();
    if (!managerClient) {
      // eslint-disable-next-line no-console
      console.error('[exportBotToken] Manager Bot client unavailable');
      return undefined;
    }

    const username = botUsername
      || (bot as any).username
      || bot.usernames?.find((u) => u.isActive)?.username
      || bot.usernames?.[0]?.username;

    // Retry loop with exponential backoff to handle Telegram DC propagation delays immediately after creation
    const MAX_RETRIES = 5;
    const RETRY_DELAYS = [800, 1200, 1600, 2000, 2500];

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const inputUser = await getManagerInputUser(managerClient, bot.id, username);

      const inputCandidates: GramJs.TypeInputUser[] = [];
      if (inputUser) {
        inputCandidates.push(inputUser);
      }
      if (bot.accessHash) {
        inputCandidates.push(new GramJs.InputUser({
          userId: BigInt(bot.id),
          accessHash: BigInt(bot.accessHash),
        }));
      }

      for (const candidate of inputCandidates) {
        try {
          // eslint-disable-next-line no-console
          console.log(`[exportBotToken] Invoking ExportBotToken attempt ${attempt + 1} for bot ${bot.id}`);
          const result = await managerClient.invoke(new GramJs.bots.ExportBotToken({
            bot: candidate,
            revoke,
          }));

          if (result && 'token' in result && typeof result.token === 'string') {
            // eslint-disable-next-line no-console
            console.log('[exportBotToken] Successfully exported token for bot', bot.id);
            exportedTokensByBotId.set(bot.id, result.token);
            return result.token;
          }
        } catch (err: any) {
          // eslint-disable-next-line no-console
          console.warn(`[exportBotToken] Attempt ${attempt + 1} candidate failed:`, err?.errorMessage || err);
        }
      }

      if (attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_DELAYS[attempt]);
      }
    }

    return undefined;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[exportBotToken] Unexpected error:', err);
    return undefined;
  }
}

// MTProto bots.setBotCommands has no bot field (bot-auth only). For owned bots we use
// the Bot HTTP API with an exported token, which is the supported owner path.
export async function setBotCommands({
  token,
  commands,
  langCode = DEFAULT_PRIMITIVES.STRING,
}: {
  token: string;
  commands: Array<{ command: string; description: string }>;
  langCode?: string;
}) {
  try {
    const response = await fetch(`${BOT_API_BASE_URL}${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands,
        language_code: '',
      }),
    });
    if (langCode) {
      await fetch(`${BOT_API_BASE_URL}${token}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commands,
          language_code: langCode,
        }),
      });
    }
    const data = await response.json() as { ok?: boolean };
    return data.ok ? true : undefined;
  } catch {
    return undefined;
  }
}

export async function resetBotCommands({
  token,
  langCode = DEFAULT_PRIMITIVES.STRING,
}: {
  token: string;
  langCode?: string;
}) {
  try {
    const response = await fetch(`${BOT_API_BASE_URL}${token}/deleteMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        language_code: '',
      }),
    });
    if (langCode) {
      await fetch(`${BOT_API_BASE_URL}${token}/deleteMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language_code: langCode,
        }),
      });
    }
    const data = await response.json() as { ok?: boolean };
    return data.ok ? true : undefined;
  } catch {
    return undefined;
  }
}

// MTProto `bots.SetBotMenuButton` requires bot-auth. For owned bots we use
// the Bot HTTP API (`/setChatMenuButton`) from the owner's user session via the exported token.
export async function setBotMenuButtonViaApi({
  token,
  url,
  text,
}: {
  token: string;
  url?: string;
  text?: string;
}) {
  const menuButton = url
    ? { type: 'web_app', text: text || 'Open', web_app: { url } }
    : { type: 'default' };
  try {
    const response = await fetch(`${BOT_API_BASE_URL}${token}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ menu_button: menuButton }),
    });
    const data = await response.json() as { ok?: boolean };
    return data.ok ? true as const : undefined;
  } catch {
    return undefined;
  }
}

let isManagerPollingStarted = false;

function ensureManagerBotPolling() {
  if (isManagerPollingStarted || !MANAGER_BOT_TOKEN) return;
  isManagerPollingStarted = true;

  let offset = 0;
  async function pollLoop() {
    while (isManagerPollingStarted) {
      try {
        const response = await fetch(
          `${BOT_API_BASE_URL}${MANAGER_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=20`,
        );
        const data = await response.json() as {
          ok?: boolean;
          result?: Array<{
            update_id: number;
            message?: {
              message_id: number;
              chat?: { id: number };
              text?: string;
            };
          }>;
        };

        if (data?.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            offset = update.update_id + 1;
            const msg = update.message;
            if (msg?.text && msg.chat?.id) {
              const text = msg.text.trim();
              if (text.startsWith('/start') || text.startsWith('/mybots') || text.startsWith('/newbot')) {
                await fetch(`${BOT_API_BASE_URL}${MANAGER_BOT_TOKEN}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chat_id: msg.chat.id,
                    text: '👋 Hello! I am BotBrother, your Bot Manager for JustChat.\n\n'
                      + 'Use /newbot to create a new bot, or tap the Open button to launch the Bot Manager.',
                    reply_markup: {
                      inline_keyboard: [
                        [{ text: '🚀 Open Bot Manager', web_app: { url: 'https://botbrother.telegram.org' } }],
                      ],
                    },
                  }),
                });
              }
            }
          }
        }
      } catch {
        // Retry delay on network error
        await new Promise((resolve) => {
          setTimeout(resolve, 5000);
        });
      }
    }
  }

  void pollLoop();
}

export async function createBot({
  name,
  username,
  managerBot,
}: {
  name: string;
  username: string;
  managerBot?: ApiUser;
}) {
  ensureManagerBotPolling();

  try {
    let managerInputUser: GramJs.TypeInputUser | undefined;

    // 1. Prefer managerBot peer from active session
    if (managerBot?.accessHash) {
      managerInputUser = buildInputUser(managerBot.id, managerBot.accessHash);
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem('tt-manager-bot-access-hash', managerBot.accessHash);
        } catch {
          // ignore
        }
      }
    } else if (MANAGER_BOT_USER_ID && MANAGER_BOT_ACCESS_HASH) {
      managerInputUser = buildInputUser(MANAGER_BOT_USER_ID, MANAGER_BOT_ACCESS_HASH);
    } else {
      const cachedAccessHash = typeof localStorage !== 'undefined'
        ? localStorage.getItem('tt-manager-bot-access-hash')
        : undefined;

      if (cachedAccessHash && MANAGER_BOT_USER_ID) {
        managerInputUser = buildInputUser(MANAGER_BOT_USER_ID, cachedAccessHash);
      } else {
        // Resolve the bot peer by username in current user session
        try {
          const resolved = await invokeRequest(new GramJs.contacts.ResolveUsername({
            username: 'botbrother123_bot',
          }), { shouldThrow: true });

          const resolvedUser = resolved?.users?.[0];
          if (resolvedUser && 'accessHash' in resolvedUser && resolvedUser.accessHash !== undefined) {
            addUserToLocalDb(resolvedUser);
            managerInputUser = new GramJs.InputUser({
              userId: BigInt(resolvedUser.id),
              accessHash: BigInt(resolvedUser.accessHash),
            });
            if (typeof localStorage !== 'undefined') {
              try {
                localStorage.setItem('tt-manager-bot-access-hash', String(resolvedUser.accessHash));
              } catch {
                // ignore
              }
            }
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[createBot] Failed to resolve manager bot username:', err);
        }
      }
    }

    if (!managerInputUser || managerInputUser instanceof GramJs.InputUserEmpty) {
      // eslint-disable-next-line no-console
      console.error('[createBot] Manager bot peer/accessHash is missing');
      return { error: 'BotFatherManagerMissing' as const };
    }

    const cleanUsername = username
      .replace(/^@/, '')
      .replace(/^t\.me\//i, '')
      .replace(/^https?:\/\/t\.me\//i, '')
      .trim();

    const result = await invokeRequest(new GramJs.bots.CreateBot({
      name,
      username: cleanUsername,
      managerId: managerInputUser,
    }), {
      shouldThrow: true,
    });

    if (!result) return undefined;

    addUserToLocalDb(result);
    const user = buildApiUser(result);
    if (!user) return undefined;

    return {
      user,
      userStatusesById: buildApiUserStatuses([result]),
    };
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error('[createBot] MTProto CreateBot failed:', err);
    if (err instanceof RPCError) {
      if (/BOT_CREATE_LIMIT_EXCEEDED/i.test(err.errorMessage)) {
        return { error: 'BotFatherLimitExceeded' as const };
      }
      if (/USERNAME_OCCUPIED/i.test(err.errorMessage)) {
        return { error: 'BotFatherUsernameTaken' as const };
      }
      if (/USERNAME_INVALID/i.test(err.errorMessage)) {
        return { error: 'BotFatherUsernameInvalid' as const };
      }
      if (/MANAGER_PERMISSION_MISSING|MANAGER_ID_INVALID|PEER_ID_INVALID/i.test(err.errorMessage)) {
        return { error: 'BotFatherManagerMissing' as const };
      }
    }
    return { error: 'BotFatherCreateError' as const };
  }
}

export async function fetchAdminedBots() {
  const result = await invokeRequest(new GramJs.bots.GetAdminedBots());
  if (!result) {
    return undefined;
  }

  const users = result.map(buildApiUser).filter(Boolean);
  const userStatusesById = buildApiUserStatuses(result);

  return {
    users,
    userStatusesById,
  };
}

export async function fetchPopularAppBots({
  offset = DEFAULT_PRIMITIVES.STRING, limit,
}: {
  offset?: string;
  limit?: number;
}) {
  const result = await invokeRequest(new GramJs.bots.GetPopularAppBots({
    offset,
    limit: limit ?? DEFAULT_PRIMITIVES.INT,
  }));

  if (!result) {
    return undefined;
  }

  const users = result.users.map(buildApiUser).filter(Boolean);
  const peerIds = users.map(({ id }) => id);

  return {
    peerIds,
    nextOffset: result.nextOffset,
  };
}

export async function fetchBotsRecommendations({ user }: { user: ApiChat }) {
  if (!user) return undefined;
  const inputUser = buildInputUser(user.id, user.accessHash);
  const result = await invokeRequest(new GramJs.bots.GetBotRecommendations({
    bot: inputUser,
  }));
  if (!result) {
    return undefined;
  }

  const similarBots = result?.users.map(buildApiUser).filter(Boolean);

  return {
    similarBots,
    count: result instanceof GramJs.users.UsersSlice ? result.count : similarBots.length,
  };
}

async function invokeUrlAuthRequest(
  request: GramJs.messages.RequestUrlAuth | GramJs.messages.AcceptUrlAuth,
): Promise<ApiUrlAuthResult | undefined> {
  try {
    const result = await invokeRequest(request, { shouldThrow: true });
    if (!result) return undefined;

    const authResult = buildApiUrlAuthResult(result);
    if (authResult?.type === 'request') {
      sendApiUpdate({
        '@type': 'updateUser',
        id: authResult.bot.id,
        user: authResult.bot,
      });
    }
    return authResult;
  } catch (err) {
    if (err instanceof RPCError && err.errorMessage === 'URL_EXPIRED') {
      return { type: 'expired' };
    }
    throw err;
  }
}

export async function fetchBotMenuButton({
  bot,
}: {
  bot: ApiUser;
}) {
  const result = await invokeRequest(new GramJs.bots.GetBotMenuButton({
    userId: buildInputUser(bot.id, bot.accessHash),
  }));

  if (!result) return undefined;

  if (result instanceof GramJs.BotMenuButton) {
    return {
      type: 'custom' as const,
      text: result.text,
      url: result.url,
      isEnabled: true,
    };
  }

  return {
    type: result instanceof GramJs.BotMenuButtonCommands ? ('commands' as const) : ('default' as const),
    isEnabled: false,
  };
}

export async function saveBotMenuButton({
  bot,
  url,
  text,
}: {
  bot: ApiUser;
  url?: string;
  text?: string;
}) {
  const button = url
    ? new GramJs.BotMenuButton({
      text: text || 'Open',
      url,
    })
    : new GramJs.BotMenuButtonDefault();

  return invokeRequest(new GramJs.bots.SetBotMenuButton({
    userId: buildInputUser(bot.id, bot.accessHash),
    button,
  }), {
    shouldReturnTrue: true,
  });
}

export async function fetchBotAccessSettings({
  bot,
}: {
  bot: ApiUser;
}) {
  const result = await invokeRequest(new GramJs.bots.GetAccessSettings({
    bot: buildInputUser(bot.id, bot.accessHash),
  }));

  if (!result) return undefined;

  return {
    isRestricted: Boolean(result.restricted),
  };
}

export async function saveBotAccessSettings({
  bot,
  isRestricted,
}: {
  bot: ApiUser;
  isRestricted: boolean;
}) {
  return invokeRequest(new GramJs.bots.EditAccessSettings({
    bot: buildInputUser(bot.id, bot.accessHash),
    restricted: isRestricted || undefined,
  }), {
    shouldReturnTrue: true,
  });
}
