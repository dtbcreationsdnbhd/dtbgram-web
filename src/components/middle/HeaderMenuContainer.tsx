import type { FC } from '../../lib/teact/teact';
import {
  memo, useEffect, useMemo, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type {
  ApiBotCommand, ApiChat, ApiChatFullInfo, ApiDisallowedGifts, ApiMessage, ApiTopic,
} from '../../api/types';
import type { IAnchorPosition, ThreadId } from '../../types';
import type { IconName } from '../../types/icons';
import { MAIN_THREAD_ID } from '../../api/types';
import { NewChatMembersProgress, SettingsScreens } from '../../types';

import { UNMUTE_TIMESTAMP } from '../../config';
import {
  getCanAddContact,
  getCanDeleteChat,
  getCanManageTopic,
  getHasAdminRight,
  getIsSavedDialog,
  isChatAdmin,
  isChatBasicGroup,
  isChatChannel,
  isChatGroup,
  isChatPublic,
  isChatSuperGroup,
  isSystemBot,
  isUserRightBanned,
} from '../../global/helpers';
import { getIsChatMuted } from '../../global/helpers/notifications';
import {
  selectBot,
  selectCanDeleteTopic,
  selectCanGift,
  selectCanManage,
  selectCanTranslateChat,
  selectChat,
  selectChatFullInfo,
  selectCurrentMessageList,
  selectIsChatRestricted,
  selectIsChatWithSelf,
  selectIsCurrentUserFrozen,
  selectIsCurrentUserPremium,
  selectIsRightColumnShown,
  selectNotifyDefaults,
  selectNotifyException,
  selectTabState,
  selectTopic,
  selectUser,
  selectUserFullInfo,
} from '../../global/selectors';
import { isUserId } from '../../util/entities/ids';
import { exportChatHistory, hasExportableMessage } from '../../util/exportChatHistory';
import { disableScrolling } from '../../util/scrollLock';

import useAppLayout from '../../hooks/useAppLayout';
import useFlag from '../../hooks/useFlag';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';
import useOldLang from '../../hooks/useOldLang';
import usePrevDuringAnimation from '../../hooks/usePrevDuringAnimation';
import useShowTransitionDeprecated from '../../hooks/useShowTransitionDeprecated';

import DeleteChatModal from '../common/DeleteChatModal';
import Icon from '../common/icons/Icon';
import MuteChatModal from '../left/MuteChatModal.async';
import ConfirmDialog from '../ui/ConfirmDialog';
import Menu from '../ui/Menu';
import MenuItem from '../ui/MenuItem';
import MenuSeparator from '../ui/MenuSeparator';
import Portal from '../ui/Portal';

import './HeaderMenuContainer.scss';

const BOT_BUTTONS: Record<string, { icon: IconName; label: string }> = {
  settings: {
    icon: 'bots',
    label: 'BotSettings',
  },
  help: {
    icon: 'help',
    label: 'BotHelp',
  },
};

export type OwnProps = {
  chatId: string;
  threadId: ThreadId;
  isOpen: boolean;
  anchor: IAnchorPosition;
  isChannel?: boolean;
  canSubscribe?: boolean;
  canSearch?: boolean;
  canCall?: boolean;
  canMute?: boolean;
  canViewStatistics?: boolean;
  canViewBoosts?: boolean;
  canViewMonetization?: boolean;
  canShowBoostModal?: boolean;
  withForumActions?: boolean;
  canLeave?: boolean;
  canEnterVoiceChat?: boolean;
  canCreateVoiceChat?: boolean;
  pendingJoinRequests?: number;
  canTranslate?: boolean;
  channelMonoforumId?: string;
  onSearchClick: () => void;
  onAsMessagesClick: () => void;
  onClose: () => void;
  onCloseAnimationEnd: () => void;
  onJoinRequestsClick?: () => void;
};

type StateProps = {
  chat?: ApiChat;
  botCommands?: ApiBotCommand[];
  botPrivacyPolicyUrl?: string;
  isPrivate?: boolean;
  isMuted?: boolean;
  isTopic?: boolean;
  topic?: ApiTopic;
  isForum?: boolean;
  isBotForum?: boolean;
  isForumAsMessages?: true;
  canAddContact?: boolean;
  canDeleteChat?: boolean;
  canReportChat?: boolean;
  canGift?: boolean;
  canCreateTopic?: boolean;
  canEditTopic?: boolean;
  hasLinkedChat?: boolean;
  isChatInfoShown?: boolean;
  isRightColumnShown?: boolean;
  canManage?: boolean;
  canTranslate?: boolean;
  isBlocked?: boolean;
  isBot?: boolean;
  isChatWithSelf?: boolean;
  isPremium?: boolean;
  canCreateGroupPoll?: boolean;
  canCreateGroupTodo?: boolean;
  canExportGroupHistory?: boolean;
  canClearGroupHistory?: boolean;
  canCreatePeerPoll?: boolean;
  canCreatePeerTodo?: boolean;
  canChangePeerColors?: boolean;
  canExportPeerHistory?: boolean;
  canClearPeerHistory?: boolean;
  canOpenStoryArchive?: boolean;
  canDeleteTopic?: boolean;
  canAddGroupMembers?: boolean;
  messagesById?: Record<number, ApiMessage>;
  savedDialog?: ApiChat;
  disallowedGifts?: ApiDisallowedGifts;
  isAccountFrozen?: boolean;
  noForwardsMyEnabled?: boolean;
  noForwardsPeerEnabled?: boolean;
};

const CLOSE_MENU_ANIMATION_DURATION = 200;

const HeaderMenuContainer: FC<OwnProps & StateProps> = ({
  chatId,
  threadId,
  isOpen,
  anchor,
  isChannel,
  canSubscribe,
  botCommands,
  botPrivacyPolicyUrl,
  withForumActions,
  isTopic,
  topic,
  isForum,
  isBotForum,
  isForumAsMessages,
  isChatInfoShown,
  canReportChat,
  canSearch,
  canCall,
  canMute,
  canViewStatistics,
  canViewMonetization,
  canViewBoosts,
  pendingJoinRequests,
  canLeave,
  canEnterVoiceChat,
  canCreateVoiceChat,
  chat,
  isPrivate,
  isMuted,
  canDeleteChat,
  canGift,
  hasLinkedChat,
  canAddContact,
  canCreateTopic,
  canEditTopic,
  canManage,
  isRightColumnShown,
  canTranslate,
  isBlocked,
  isBot,
  isChatWithSelf,
  isPremium,
  canCreateGroupPoll,
  canCreateGroupTodo,
  canExportGroupHistory,
  canClearGroupHistory,
  canCreatePeerPoll,
  canCreatePeerTodo,
  canChangePeerColors,
  canExportPeerHistory,
  canClearPeerHistory,
  canOpenStoryArchive,
  canDeleteTopic,
  canAddGroupMembers,
  messagesById,
  savedDialog,
  canShowBoostModal,
  disallowedGifts,
  isAccountFrozen,
  noForwardsMyEnabled,
  noForwardsPeerEnabled,
  channelMonoforumId,
  onJoinRequestsClick,
  onSearchClick,
  onAsMessagesClick,
  onClose,
  onCloseAnimationEnd,
}) => {
  const {
    updateChatMutedState,
    enterMessageSelectMode,
    sendBotCommand,
    restartBot,
    requestMasterAndJoinGroupCall,
    createGroupCall,
    joinChannel,
    openLinkedChat,
    openAddContactDialog,
    openFrozenAccountModal,
    requestMasterAndRequestCall,
    toggleStatistics,
    openMonetizationStatistics,
    openBoostStatistics,
    openGiftModal,
    openThreadWithInfo,
    openChatWithInfo,
    openCreateTopicPanel,
    openEditTopicPanel,
    openChat,
    openUrl,
    toggleManagement,
    togglePeerTranslations,
    openPollModal,
    openTodoListModal,
    openSettingsScreen,
    blockUser,
    unblockUser,
    setViewForumAsMessages,
    openBoostModal,
    reportMessages,
    showNotification,
    toggleNoForwards,
    openDisableSharingAboutModal,
    editTopic,
    deleteTopic,
    setNewChatMembersDialogState,
  } = getActions();

  const oldLang = useOldLang();
  const lang = useLang();

  const { isMobile } = useAppLayout();
  const [isMenuOpen, setIsMenuOpen] = useState(true);
  const [shouldCloseFast, setShouldCloseFast] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isClearHistory, setIsClearHistory] = useState(false);
  const [isMuteModalOpen, setIsMuteModalOpen] = useState(false);
  const [isDeleteTopicModalOpen, openDeleteTopicModal, closeDeleteTopicModal] = useFlag();
  const [shouldRenderMuteModal, markRenderMuteModal, unmarkRenderMuteModal] = useFlag();
  const { x, y } = anchor;

  useShowTransitionDeprecated(isOpen, onCloseAnimationEnd, undefined, false);
  const isViewGroupInfoShown = usePrevDuringAnimation(
    (!isChatInfoShown && isForum) ? true : undefined, CLOSE_MENU_ANIMATION_DURATION,
  );
  const viewInfoLangKey = getViewInfoLangKey(isTopic, isBotForum, isPrivate, isChannel);
  const canViewPeerInfo = Boolean(
    isViewGroupInfoShown || (!isChatInfoShown && !isChatWithSelf && !savedDialog && !withForumActions),
  );

  const areAllGiftsDisallowed = useMemo(() => {
    if (!disallowedGifts) {
      return undefined;
    }
    return Object.values(disallowedGifts).every(Boolean);
  }, [disallowedGifts]);

  const closeMuteModal = useLastCallback(() => {
    setIsMuteModalOpen(false);
    onClose();
  });

  const handleReport = useLastCallback(() => {
    if (isAccountFrozen) {
      openFrozenAccountModal();
    } else {
      setIsMenuOpen(false);
      reportMessages({ chatId, messageIds: [] });
    }
    onClose();
  });

  const handleDelete = useLastCallback(() => {
    if (isAccountFrozen) {
      openFrozenAccountModal();
      onClose();
    } else {
      setIsClearHistory(false);
      setIsDeleteModalOpen(true);
    }
    setIsMenuOpen(false);
  });

  const closeMenu = useLastCallback(() => {
    setIsMenuOpen(false);
    onClose();
  });

  const handleViewGroupInfo = useLastCallback(() => {
    openThreadWithInfo({ chatId, threadId });
    setShouldCloseFast(!isRightColumnShown);
    closeMenu();
  });

  const closeDeleteModal = useLastCallback(() => {
    setIsDeleteModalOpen(false);
    setIsClearHistory(false);
    onClose();
  });

  const handleCreatePoll = useLastCallback(() => {
    openPollModal({ chatId, threadId, messageListType: 'thread' });
    closeMenu();
  });

  const handleCreateTodo = useLastCallback(() => {
    if (!isPremium) return;
    openTodoListModal({ chatId });
    closeMenu();
  });

  const handleExportHistory = useLastCallback(async () => {
    if (!chat) return;
    const isSavedMessages = Boolean(isChatWithSelf && !savedDialog);
    closeMenu();
    const didExport = await exportChatHistory(chat, isSavedMessages ? 'saved-messages' : undefined);
    showNotification({
      message: {
        key: didExport
          ? (isSavedMessages ? 'SavedExportDone' : 'GroupExportDone')
          : (isSavedMessages ? 'SavedExportEmpty' : 'GroupExportEmpty'),
      },
    });
  });

  const handleChangeColors = useLastCallback(() => {
    openSettingsScreen({ screen: SettingsScreens.GeneralChatBackground });
    closeMenu();
  });

  const handleOpenStoryArchive = useLastCallback(() => {
    openChatWithInfo({ id: chatId, profileTab: 'storiesArchive' });
    closeMenu();
  });

  const handleAddGroupMembers = useLastCallback(() => {
    setNewChatMembersDialogState({ newChatMembersProgress: NewChatMembersProgress.InProgress });
    closeMenu();
  });

  const handleToggleTopicClosed = useLastCallback(() => {
    if (!topic) return;
    editTopic({ chatId, topicId: topic.id, isClosed: !topic.isClosed });
    closeMenu();
  });

  const handleOpenDeleteTopicModal = useLastCallback(() => {
    openDeleteTopicModal();
    setIsMenuOpen(false);
  });

  const handleDeleteTopic = useLastCallback(() => {
    if (!topic) return;
    deleteTopic({ chatId, topicId: topic.id });
    closeDeleteTopicModal();
    closeMenu();
  });

  const handleDeleteSavedChat = useLastCallback(() => {
    setIsClearHistory(false);
    handleDelete();
  });

  const handleClearHistory = useLastCallback(() => {
    if (isAccountFrozen) {
      openFrozenAccountModal();
      onClose();
      return;
    }

    setIsClearHistory(true);
    setIsDeleteModalOpen(true);
    setIsMenuOpen(false);
  });

  const handleRestartBot = useLastCallback(() => {
    if (isAccountFrozen) {
      openFrozenAccountModal();
    } else {
      restartBot({ chatId });
    }
  });

  const handleUnmuteClick = useLastCallback(() => {
    if (isAccountFrozen) {
      openFrozenAccountModal();
    } else {
      updateChatMutedState({ chatId, mutedUntil: UNMUTE_TIMESTAMP });
    }
    closeMenu();
  });

  const handleMuteClick = useLastCallback(() => {
    if (isAccountFrozen) {
      openFrozenAccountModal();
      closeMenu();
    } else {
      markRenderMuteModal();
      setIsMuteModalOpen(true);
    }
    setIsMenuOpen(false);
  });

  const handleCreateTopicClick = useLastCallback(() => {
    if (isAccountFrozen) {
      openFrozenAccountModal();
    } else {
      openCreateTopicPanel({ chatId });
      setShouldCloseFast(!isRightColumnShown);
    }
    closeMenu();
  });

  const handleEditClick = useLastCallback(() => {
    if (isAccountFrozen) {
      openFrozenAccountModal();
    } else {
      toggleManagement({ force: true });
      setShouldCloseFast(!isRightColumnShown);
    }
    closeMenu();
  });

  const handleEditTopicClick = useLastCallback(() => {
    if (isAccountFrozen) {
      openFrozenAccountModal();
    } else {
      openEditTopicPanel({ chatId, topicId: Number(threadId) });
      setShouldCloseFast(!isRightColumnShown);
    }
    closeMenu();
  });

  const handleViewAsTopicsClick = useLastCallback(() => {
    openChat({ id: undefined });
    setViewForumAsMessages({ chatId, isEnabled: false });
    closeMenu();
  });

  const handleEnterVoiceChatClick = useLastCallback(() => {
    if (isAccountFrozen) {
      openFrozenAccountModal();
    } else if (canCreateVoiceChat) {
      // TODO Show popup to schedule
      createGroupCall({
        chatId,
      });
    } else {
      requestMasterAndJoinGroupCall({
        chatId,
      });
    }
    closeMenu();
  });

  const handleLinkedChatClick = useLastCallback(() => {
    openLinkedChat({ id: chatId });
    closeMenu();
  });

  const handleGiftClick = useLastCallback(() => {
    if (areAllGiftsDisallowed && chat) {
      showNotification({ message: lang('SendDisallowError') });
      return;
    }
    openGiftModal({ forUserId: chatId });
    if (isAccountFrozen) {
      openFrozenAccountModal();
    } else {
      openGiftModal({ forUserId: chatId });
    }
    closeMenu();
  });

  const handleAddContactClick = useLastCallback(() => {
    if (isAccountFrozen) {
      openFrozenAccountModal();
    } else {
      openAddContactDialog({ userId: chatId });
    }
    closeMenu();
  });

  const handleVideoCall = useLastCallback(() => {
    if (isAccountFrozen) {
      openFrozenAccountModal();
    } else {
      requestMasterAndRequestCall({ userId: chatId, isVideo: true });
    }
    closeMenu();
  });

  const handleCall = useLastCallback(() => {
    if (isAccountFrozen) {
      openFrozenAccountModal();
    } else {
      requestMasterAndRequestCall({ userId: chatId });
    }
    closeMenu();
  });

  const handleSearch = useLastCallback(() => {
    onSearchClick();
    closeMenu();
  });

  const handleStatisticsClick = useLastCallback(() => {
    toggleStatistics();
    setShouldCloseFast(!isRightColumnShown);
    closeMenu();
  });

  const handleMonetizationClick = useLastCallback(() => {
    openMonetizationStatistics({ chatId });
    setShouldCloseFast(!isRightColumnShown);
    closeMenu();
  });

  const handleBoostClick = useLastCallback(() => {
    if (isAccountFrozen) {
      openFrozenAccountModal();
    } else if (canViewBoosts) {
      openBoostStatistics({ chatId });
      setShouldCloseFast(!isRightColumnShown);
    } else {
      openBoostModal({ chatId });
    }
    closeMenu();
  });

  const handleEnableTranslations = useLastCallback(() => {
    togglePeerTranslations({ chatId, isEnabled: true });
    closeMenu();
  });

  const handleSelectMessages = useLastCallback(() => {
    if (isAccountFrozen) {
      openFrozenAccountModal();
    } else {
      enterMessageSelectMode();
    }
    closeMenu();
  });

  const handleOpenAsMessages = useLastCallback(() => {
    onAsMessagesClick();
    closeMenu();
  });

  const handleBlock = useLastCallback(() => {
    if (isAccountFrozen) {
      openFrozenAccountModal();
    } else {
      blockUser({ userId: chatId });
    }
    closeMenu();
  });

  const handleUnblock = useLastCallback(() => {
    if (isAccountFrozen) {
      openFrozenAccountModal();
    } else {
      unblockUser({ userId: chatId });
    }
    closeMenu();
  });

  const handleToggleNoForwards = useLastCallback(() => {
    closeMenu();
    if (isAccountFrozen) {
      openFrozenAccountModal();
      return;
    }

    if (noForwardsMyEnabled || noForwardsPeerEnabled) {
      toggleNoForwards({ userId: chatId, isEnabled: false });
      return;
    }

    openDisableSharingAboutModal({ userId: chatId });
  });

  const handleSubscribe = useLastCallback(() => {
    if (isAccountFrozen) {
      openFrozenAccountModal();
    } else {
      joinChannel({ chatId });
    }
    closeMenu();
  });

  const handleSendChannelMessage = useLastCallback(() => {
    openChat({ id: channelMonoforumId });
    closeMenu();
  });

  useEffect(disableScrolling, []);

  const botButtons = useMemo(() => {
    const commandButtons = botCommands?.map((botCommand) => {
      const { command } = botCommand;
      const cmd = BOT_BUTTONS[command];
      if (!cmd) return undefined;

      const handleClick = () => {
        sendBotCommand({
          command: `/${command}`,
          botId: botCommand.botId,
        });
        closeMenu();
      };

      return (
        <MenuItem
          key={command}
          icon={cmd.icon}

          onClick={handleClick}
        >
          <span className="ephemeral-command-label">
            {oldLang(cmd.label)}
            {botCommand.isEphemeral && (
              <Icon
                name="eye-outline"
                className="ephemeral-command-icon"
                ariaLabel={lang('EphemeralOnlyVisible')}
              />
            )}
          </span>
        </MenuItem>
      );
    });

    const hasPrivacyCommand = botCommands?.some(({ command }) => command === 'privacy');

    const privacyButton = isBot && (
      <MenuItem
        icon="privacy-policy"

        onClick={() => {
          if (hasPrivacyCommand && !botPrivacyPolicyUrl) {
            sendBotCommand({ command: '/privacy' });
          } else {
            openUrl({ url: botPrivacyPolicyUrl || oldLang('BotDefaultPrivacyPolicy') });
          }
          closeMenu();
        }}
      >
        {oldLang('BotPrivacyPolicy')}
      </MenuItem>
    );

    return [...commandButtons || [], privacyButton].filter(Boolean);
  }, [botCommands, oldLang, lang, botPrivacyPolicyUrl, isBot]);

  const isSavedHeaderMenu = Boolean(isChatWithSelf && !savedDialog);
  const isGroupHeaderMenu = Boolean(chat && isChatGroup(chat) && !withForumActions && !savedDialog && !isTopic);
  const canShowSavedExport = useMemo(
    () => isSavedHeaderMenu && hasExportableMessage(messagesById ? Object.values(messagesById) : undefined),
    [isSavedHeaderMenu, messagesById],
  );
  const canShowGroupExport = useMemo(
    () => Boolean(canExportGroupHistory)
      && hasExportableMessage(messagesById ? Object.values(messagesById) : undefined),
    [canExportGroupHistory, messagesById],
  );
  const canShowPeerExport = useMemo(
    () => Boolean(canExportPeerHistory)
      && hasExportableMessage(messagesById ? Object.values(messagesById) : undefined),
    [canExportPeerHistory, messagesById],
  );

  function renderSavedHeaderMenu() {
    return (
      <>
        <MenuItem icon="poll" onClick={handleCreatePoll}>
          {lang('SavedCreatePoll')}
        </MenuItem>
        {isPremium && (
          <MenuItem icon="task-list" onClick={handleCreateTodo}>
            {lang('SavedCreateTodo')}
          </MenuItem>
        )}
        <MenuItem icon="colorize" onClick={handleChangeColors}>
          {lang('SavedChangeColors')}
        </MenuItem>
        {canShowSavedExport && (
          <MenuItem icon="download" onClick={handleExportHistory}>
            {lang('SavedExportHistory')}
          </MenuItem>
        )}
        {canTranslate && (
          <MenuItem icon="language" onClick={handleEnableTranslations}>
            {oldLang('lng_context_translate')}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem icon="clear" onClick={handleClearHistory}>
          {lang('SavedClearHistory')}
        </MenuItem>
        <MenuItem destructive icon="delete" onClick={handleDeleteSavedChat}>
          {lang('SavedDeleteChat')}
        </MenuItem>
      </>
    );
  }

  function renderForumHeaderMenu() {
    return (
      <>
        {canCreateTopic && (
          <MenuItem icon="comments" onClick={handleCreateTopicClick}>
            {oldLang('lng_forum_create_topic')}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem icon="info" onClick={handleViewGroupInfo}>
          {lang('GroupViewInfo')}
        </MenuItem>
        {!isBotForum && !isForumAsMessages && (
          <MenuItem icon="message" onClick={handleOpenAsMessages}>
            {oldLang('lng_forum_view_as_messages')}
          </MenuItem>
        )}
        {canSearch && (
          <MenuItem icon="search" onClick={handleSearch}>
            {oldLang('Search')}
          </MenuItem>
        )}
        {canManage && (
          <MenuItem icon="settings" onClick={handleEditClick}>
            {lang('GroupManage')}
          </MenuItem>
        )}
        {canAddGroupMembers && (
          <MenuItem icon="add-user" onClick={handleAddGroupMembers}>
            {lang('GroupAddMembers')}
          </MenuItem>
        )}
        {(canShowBoostModal || canViewBoosts) && (
          <MenuItem icon="boost" onClick={handleBoostClick}>
            {lang('GroupBoost')}
          </MenuItem>
        )}
        {(canEnterVoiceChat || canCreateVoiceChat) && (
          <MenuItem icon="voice-chat" onClick={handleEnterVoiceChatClick}>
            {lang('GroupJoinVideoChat')}
          </MenuItem>
        )}
        <MenuSeparator />
        {canReportChat && (
          <MenuItem icon="warning" onClick={handleReport}>
            {lang('GroupReport')}
          </MenuItem>
        )}
        {canLeave && (
          <MenuItem destructive icon="logout" onClick={handleDelete}>
            {lang('GroupLeave')}
          </MenuItem>
        )}
      </>
    );
  }

  function renderGroupHeaderMenu() {
    return (
      <>
        {canMute && (isMuted ? (
          <MenuItem icon="unmute" onClick={handleUnmuteClick}>
            {lang('GroupUnmuteNotifications')}
          </MenuItem>
        ) : (
          <MenuItem icon="mute" onClick={handleMuteClick}>
            {lang('GroupMuteNotifications')}
          </MenuItem>
        ))}
        {!isChatInfoShown && (
          <MenuItem icon="info" onClick={handleViewGroupInfo}>
            {lang('GroupViewInfo')}
          </MenuItem>
        )}
        {canManage && (
          <MenuItem icon="settings" onClick={handleEditClick}>
            {lang('GroupManage')}
          </MenuItem>
        )}
        {canOpenStoryArchive && (
          <MenuItem icon="archive" onClick={handleOpenStoryArchive}>
            {lang('ProfileTabStoriesArchive')}
          </MenuItem>
        )}
        {(canShowBoostModal || canViewBoosts) && (
          <MenuItem icon="boost" onClick={handleBoostClick}>
            {lang('GroupBoost')}
          </MenuItem>
        )}
        {canCreateGroupPoll && (
          <MenuItem icon="poll" onClick={handleCreatePoll}>
            {lang('GroupCreatePoll')}
          </MenuItem>
        )}
        {canCreateGroupTodo && (
          <MenuItem icon="task-list" onClick={handleCreateTodo}>
            {lang('GroupCreateTodo')}
          </MenuItem>
        )}
        {canShowGroupExport && (
          <MenuItem icon="download" onClick={handleExportHistory}>
            {lang('GroupExportHistory')}
          </MenuItem>
        )}
        {canTranslate && (
          <MenuItem icon="language" onClick={handleEnableTranslations}>
            {oldLang('lng_context_translate')}
          </MenuItem>
        )}
        {canReportChat && (
          <MenuItem icon="warning" onClick={handleReport}>
            {lang('GroupReport')}
          </MenuItem>
        )}
        {canClearGroupHistory && (
          <>
            <MenuSeparator />
            <MenuItem icon="clear" onClick={handleClearHistory}>
              {lang('GroupClearHistory')}
            </MenuItem>
          </>
        )}
        {canLeave && (
          <MenuItem destructive icon="logout" onClick={handleDelete}>
            {lang('GroupLeave')}
          </MenuItem>
        )}
      </>
    );
  }

  function renderPeerDesktopActions() {
    return (
      <>
        {canOpenStoryArchive && (
          <MenuItem icon="archive" onClick={handleOpenStoryArchive}>
            {lang('ProfileTabStoriesArchive')}
          </MenuItem>
        )}
        {canCreatePeerPoll && (
          <MenuItem icon="poll" onClick={handleCreatePoll}>
            {lang('ChatCreatePoll')}
          </MenuItem>
        )}
        {canCreatePeerTodo && (
          <MenuItem icon="task-list" onClick={handleCreateTodo}>
            {lang('ChatCreateTodo')}
          </MenuItem>
        )}
        {canChangePeerColors && (
          <MenuItem icon="colorize" onClick={handleChangeColors}>
            {lang('ChatChangeColors')}
          </MenuItem>
        )}
        {canShowPeerExport && (
          <MenuItem icon="download" onClick={handleExportHistory}>
            {lang('ChatExportHistory')}
          </MenuItem>
        )}
        {isTopic && canEditTopic && (
          <MenuItem icon={topic?.isClosed ? 'comments' : 'lock'} onClick={handleToggleTopicClosed}>
            {oldLang(topic?.isClosed ? 'lng_forum_topic_reopen' : 'lng_forum_topic_close')}
          </MenuItem>
        )}
        {isTopic && canDeleteTopic && (
          <MenuItem destructive icon="delete" onClick={handleOpenDeleteTopicModal}>
            {oldLang('lng_forum_topic_delete')}
          </MenuItem>
        )}
      </>
    );
  }

  const deleteTitle = useMemo(() => {
    if (!chat) return undefined;

    if (savedDialog) {
      return oldLang('Delete');
    }

    if (isPrivate) {
      return oldLang('DeleteChatUser');
    }

    if (canDeleteChat) {
      return oldLang('GroupInfo.DeleteAndExit');
    }

    if (isChannel) {
      return oldLang('LeaveChannel');
    }

    return oldLang('Group.LeaveGroup');
  }, [canDeleteChat, chat, isChannel, isPrivate, savedDialog, oldLang]);

  return (
    <Portal>
      <div className="HeaderMenuContainer">
        <Menu
          isOpen={isMenuOpen}
          positionX="right"
          style={`left: ${x}px;top: ${y}px;`}
          onClose={closeMenu}
          shouldCloseFast={shouldCloseFast}
        >
          {isSavedHeaderMenu
            ? renderSavedHeaderMenu()
            : withForumActions
              ? renderForumHeaderMenu()
              : isGroupHeaderMenu ? renderGroupHeaderMenu() : (
                <>
                  {isMobile && canSearch && (
                    <MenuItem
                      icon="search"
                      onClick={handleSearch}
                    >
                      {oldLang('Search')}
                    </MenuItem>
                  )}
                  {withForumActions && canCreateTopic && (
                    <>
                      <MenuItem
                        icon="comments"
                        onClick={handleCreateTopicClick}
                      >
                        {oldLang('lng_forum_create_topic')}
                      </MenuItem>
                      <MenuSeparator />
                    </>
                  )}
                  {canSubscribe && (
                    <MenuItem
                      icon={isChannel ? 'channel' : 'group'}
                      onClick={handleSubscribe}
                    >
                      {oldLang(isChannel ? 'ProfileJoinChannel' : 'ProfileJoinGroup')}
                    </MenuItem>
                  )}
                  {channelMonoforumId && (
                    <MenuItem
                      icon="message"
                      onClick={handleSendChannelMessage}
                    >
                      {lang('ChannelSendMessage')}
                    </MenuItem>
                  )}
                  {canViewPeerInfo && (
                    <MenuItem
                      icon="info"
                      onClick={handleViewGroupInfo}
                    >
                      {lang(viewInfoLangKey)}
                    </MenuItem>
                  )}
                  {canManage && !canEditTopic && (
                    <MenuItem
                      icon="edit"
                      onClick={handleEditClick}
                    >
                      {oldLang('Edit')}
                    </MenuItem>
                  )}
                  {canEditTopic && (
                    <MenuItem
                      icon="edit"
                      onClick={handleEditTopicClick}
                    >
                      {oldLang('lng_forum_topic_edit')}
                    </MenuItem>
                  )}
                  {isMobile && !withForumActions && isForum && !isBotForum && !isTopic && (
                    <MenuItem
                      icon="forums"
                      onClick={handleViewAsTopicsClick}
                    >
                      {oldLang('Chat.ContextViewAsTopics')}
                    </MenuItem>
                  )}
                  {withForumActions && Boolean(pendingJoinRequests) && (
                    <MenuItem
                      icon="user"
                      onClick={onJoinRequestsClick}
                    >
                      {isChannel ? oldLang('SubscribeRequests') : oldLang('MemberRequests')}
                      <div className="right-badge">{pendingJoinRequests}</div>
                    </MenuItem>
                  )}
                  {withForumActions && !isTopic && !isBotForum && !isForumAsMessages && (
                    <MenuItem
                      icon="message"
                      onClick={handleOpenAsMessages}
                    >
                      {oldLang('lng_forum_view_as_messages')}
                    </MenuItem>
                  )}
                  {canShowBoostModal && !canViewBoosts && (
                    <MenuItem
                      icon="boost-outline"
                      onClick={handleBoostClick}
                    >
                      {oldLang(isChannel ? 'BoostingBoostChannelMenu' : 'BoostingBoostGroupMenu')}
                    </MenuItem>
                  )}
                  {canAddContact && (
                    <MenuItem
                      icon="add-user"
                      onClick={handleAddContactClick}
                    >
                      {oldLang('AddContact')}
                    </MenuItem>
                  )}
                  {isMobile && canCall && (
                    <MenuItem
                      icon="phone"
                      onClick={handleCall}
                    >
                      {oldLang('Call')}
                    </MenuItem>
                  )}
                  {canCall && (
                    <MenuItem
                      icon="video-outlined"
                      onClick={handleVideoCall}
                    >
                      {oldLang('VideoCall')}
                    </MenuItem>
                  )}
                  {canMute && (isMuted ? (
                    <MenuItem
                      icon="unmute"
                      onClick={handleUnmuteClick}
                    >
                      {oldLang('ChatsUnmute')}
                    </MenuItem>
                  )
                    : (
                      <MenuItem
                        icon="mute"
                        onClick={handleMuteClick}
                      >
                        {oldLang('ChatsMute')}
                        ...
                      </MenuItem>
                    )
                  )}
                  {(canEnterVoiceChat || canCreateVoiceChat) && (
                    <MenuItem
                      icon="voice-chat"
                      onClick={handleEnterVoiceChatClick}
                    >
                      {oldLang(canCreateVoiceChat ? 'StartVoipChat' : 'VoipGroupJoinCall')}
                    </MenuItem>
                  )}
                  {hasLinkedChat && (
                    <MenuItem
                      icon={isChannel ? 'comments' : 'channel'}
                      onClick={handleLinkedChatClick}
                    >
                      {oldLang(isChannel ? 'ViewDiscussion' : 'lng_profile_view_channel')}
                    </MenuItem>
                  )}
                  {renderPeerDesktopActions()}
                  {!withForumActions && (
                    <MenuItem
                      icon="select"
                      onClick={handleSelectMessages}
                    >
                      {oldLang('ReportSelectMessages')}
                    </MenuItem>
                  )}
                  {canViewBoosts && (
                    <MenuItem
                      icon="boost-outline"
                      onClick={handleBoostClick}
                    >
                      {oldLang('Boosts')}
                    </MenuItem>
                  )}
                  {canViewStatistics && (
                    <MenuItem
                      icon="stats"
                      onClick={handleStatisticsClick}
                    >
                      {oldLang('Statistics')}
                    </MenuItem>
                  )}
                  {isChannel && canViewMonetization && (
                    <MenuItem
                      icon="cash-circle"
                      onClick={handleMonetizationClick}
                    >
                      {oldLang('lng_channel_earn_title')}
                    </MenuItem>
                  )}
                  {canTranslate && (
                    <MenuItem
                      icon="language"
                      onClick={handleEnableTranslations}
                    >
                      {oldLang('lng_context_translate')}
                    </MenuItem>
                  )}
                  {canReportChat && (
                    <MenuItem
                      icon="flag"
                      onClick={handleReport}
                    >
                      {oldLang('ReportPeer.Report')}
                    </MenuItem>
                  )}
                  {botButtons}
                  {canGift && (
                    <MenuItem
                      icon="gift"
                      onClick={handleGiftClick}
                    >
                      {oldLang('ProfileSendAGift')}
                    </MenuItem>
                  )}
                  {isBot && (
                    <MenuItem
                      icon={isBlocked ? 'bots' : 'hand-stop'}
                      onClick={isBlocked ? handleRestartBot : handleBlock}
                    >
                      {isBlocked ? oldLang('BotRestart') : oldLang('Bot.Stop')}
                    </MenuItem>
                  )}
                  {isPrivate && !isChatWithSelf && !isBot && (
                    <MenuItem
                      icon={noForwardsMyEnabled || noForwardsPeerEnabled ? 'allow-share' : 'no-share'}
                      onClick={handleToggleNoForwards}
                    >
                      {noForwardsMyEnabled || noForwardsPeerEnabled ? lang('EnableSharing') : lang('DisableSharing')}
                    </MenuItem>
                  )}
                  {isPrivate && !isChatWithSelf && !isBot && (
                    <MenuItem
                      icon={isBlocked ? 'user' : 'hand-stop'}
                      onClick={isBlocked ? handleUnblock : handleBlock}
                    >
                      {isBlocked ? oldLang('Unblock') : oldLang('BlockUser')}
                    </MenuItem>
                  )}
                  {canClearPeerHistory && (
                    <>
                      <MenuSeparator />
                      <MenuItem icon="clear" onClick={handleClearHistory}>
                        {lang('ChatClearHistory')}
                      </MenuItem>
                    </>
                  )}
                  {canLeave && (
                    <>
                      {!canClearPeerHistory && <MenuSeparator />}
                      <MenuItem
                        destructive
                        icon="delete"
                        onClick={handleDelete}
                      >
                        {deleteTitle}
                      </MenuItem>
                    </>
                  )}
                </>
              )}
        </Menu>
        {chat && (
          <DeleteChatModal
            isOpen={isDeleteModalOpen}
            onClose={closeDeleteModal}
            chat={savedDialog || chat}
            isSavedDialog={Boolean(savedDialog)}
            isClearHistory={isClearHistory}
          />
        )}
        {canMute && shouldRenderMuteModal && chat?.id && (
          <MuteChatModal
            isOpen={isMuteModalOpen}
            onClose={closeMuteModal}
            onCloseAnimationEnd={unmarkRenderMuteModal}
            chatId={chat.id}
          />
        )}
        <ConfirmDialog
          isOpen={isDeleteTopicModalOpen}
          onClose={closeDeleteTopicModal}
          confirmIsDestructive
          confirmHandler={handleDeleteTopic}
          text={oldLang('lng_forum_topic_delete_sure')}
          confirmLabel={oldLang('Delete')}
        />
      </div>
    </Portal>
  );
};

function getCanCreateGroupPolls(chat: ApiChat, chatFullInfo?: ApiChatFullInfo) {
  return isChatAdmin(chat) || !isUserRightBanned(chat, 'sendPolls', chatFullInfo);
}

function getCanClearGroupHistory(chat: ApiChat) {
  if (isChatBasicGroup(chat)) return true;

  const canDeleteMessages = chat.isCreator || getHasAdminRight(chat, 'deleteMessages');
  return canDeleteMessages || (!isChatPublic(chat) && !chat.isForum);
}

function getViewInfoLangKey(
  isTopic: boolean | undefined,
  isBotForum: boolean | undefined,
  isPrivate: boolean | undefined,
  isChannel: boolean | undefined,
) {
  if (isTopic) {
    return 'HeaderMenuViewTopicInfo';
  }

  if (isBotForum) {
    return 'HeaderMenuViewProfile';
  }

  if (isPrivate) {
    return 'HeaderMenuViewProfile';
  }

  if (isChannel) {
    return 'HeaderMenuViewChannelInfo';
  }

  return 'HeaderMenuViewGroupInfo';
}

export default memo(withGlobal<OwnProps>(
  (global, { chatId, threadId }): Complete<StateProps> => {
    const chat = selectChat(global, chatId);
    const isRestricted = selectIsChatRestricted(global, chatId);
    if (!chat || isRestricted) {
      return {} as Complete<StateProps>;
    }
    const isPrivate = isUserId(chat.id);
    const user = isPrivate ? selectUser(global, chatId) : undefined;
    const canAddContact = user && getCanAddContact(user);
    const isMainThread = threadId === MAIN_THREAD_ID;
    const isChatWithSelf = selectIsChatWithSelf(global, chatId);
    const { chatId: currentChatId, threadId: currentThreadId } = selectCurrentMessageList(global) || {};
    const canReportChat = isMainThread && !user && (isChatChannel(chat) || isChatGroup(chat)) && !chat.isCreator;

    const chatBot = !isSystemBot(chatId) ? selectBot(global, chatId) : undefined;
    const userFullInfo = isPrivate ? selectUserFullInfo(global, chatId) : undefined;
    const chatFullInfo = !isPrivate ? selectChatFullInfo(global, chatId) : undefined;
    const fullInfo = userFullInfo || chatFullInfo;
    const canGift = selectCanGift(global, chatId);

    const topic = selectTopic(global, chatId, threadId);
    // Disable manual creation for bot forums
    const canCreateTopic = chat.isForum && !chat.isBotForum && (
      chat.isCreator || !isUserRightBanned(chat, 'manageTopics') || getHasAdminRight(chat, 'manageTopics')
    );
    const canEditTopic = topic && getCanManageTopic(chat, topic);
    const canManage = selectCanManage(global, chatId);
    // Context menu item should only be displayed if user hid translation panel
    const isPremium = selectIsCurrentUserPremium(global);
    const isGroup = isChatGroup(chat);
    const translationOffered = selectCanTranslateChat(global, chatId);
    const canTranslate = isChatWithSelf || isGroup
      ? Boolean(
        isPremium
        && global.settings.byKey.canTranslateChats
        && translationOffered
        && fullInfo?.isTranslationDisabled,
      )
      : Boolean(translationOffered && fullInfo?.isTranslationDisabled);
    const isGroupMember = isGroup && !chat.isMonoforum && !chat.isNotJoined;
    const canSendGroupPolls = getCanCreateGroupPolls(chat, chatFullInfo);
    const isChannelMember = isChatChannel(chat) && !chat.isMonoforum && !chat.isNotJoined;
    const canCreatePeerPoll = (isMainThread && Boolean(chatBot) && !chat.isSupport)
      || (Boolean(topic) && canSendGroupPolls);
    const canCreatePeerTodo = isPremium && (
      (isMainThread && isPrivate && !chat.isSupport) || (Boolean(topic) && canSendGroupPolls)
    );
    const canExportPeerHistory = isMainThread && !isChatWithSelf && !isGroup
      && !chat.isProtected && (isPrivate || isChannelMember);
    const canClearPeerHistory = isMainThread && !isChatWithSelf && !isGroup
      && (isPrivate || (isChannelMember && getCanClearGroupHistory(chat)));

    const isSavedDialog = getIsSavedDialog(chatId, threadId, global.currentUserId);
    const savedDialog = isSavedDialog ? selectChat(global, String(threadId)) : undefined;
    const isAccountFrozen = selectIsCurrentUserFrozen(global);
    const chatInfo = selectTabState(global).chatInfo;

    return {
      chat,
      isMuted: getIsChatMuted(chat, selectNotifyDefaults(global), selectNotifyException(global, chat.id)),
      isPrivate,
      isTopic: chat?.isForum && !isMainThread,
      topic,
      isForum: chat?.isForum,
      isBotForum: chat?.isBotForum,
      isForumAsMessages: chat?.isForumAsMessages,
      canAddContact,
      canDeleteChat: getCanDeleteChat(chat),
      canReportChat,
      canGift,
      hasLinkedChat: Boolean(chatFullInfo?.linkedChatId),
      botCommands: chatBot ? userFullInfo?.botInfo?.commands : undefined,
      botPrivacyPolicyUrl: chatBot ? userFullInfo?.botInfo?.privacyPolicyUrl : undefined,
      isChatInfoShown: chatInfo.isOpen && currentChatId === chatId && currentThreadId === threadId,
      canCreateTopic,
      canEditTopic,
      canManage,
      isRightColumnShown: selectIsRightColumnShown(global),
      canTranslate,
      isBlocked: userFullInfo?.isBlocked,
      isBot: Boolean(chatBot),
      isChatWithSelf,
      isPremium,
      canCreateGroupPoll: isGroupMember && canSendGroupPolls,
      canCreateGroupTodo: isGroupMember && canSendGroupPolls && isPremium,
      canExportGroupHistory: isGroupMember && !chat.isProtected,
      canClearGroupHistory: isGroupMember && isMainThread && getCanClearGroupHistory(chat),
      canCreatePeerPoll,
      canCreatePeerTodo,
      canChangePeerColors: isMainThread && isPrivate && !isChatWithSelf && !chat.isForbidden,
      canExportPeerHistory,
      canClearPeerHistory,
      canOpenStoryArchive: isMainThread && (isChatChannel(chat) || isChatSuperGroup(chat))
        && Boolean(chat.isCreator || getHasAdminRight(chat, 'editStories')),
      canDeleteTopic: topic ? selectCanDeleteTopic(global, chatId, topic.id) : false,
      canAddGroupMembers: isGroup && (
        chat.isCreator
        || getHasAdminRight(chat, 'inviteUsers')
        || !isUserRightBanned(chat, 'inviteUsers', chatFullInfo)
      ),
      messagesById: global.messages.byChatId[chatId]?.byId,
      savedDialog,
      disallowedGifts: userFullInfo?.disallowedGifts,
      isAccountFrozen,
      noForwardsMyEnabled: userFullInfo?.noForwardsMyEnabled,
      noForwardsPeerEnabled: userFullInfo?.noForwardsPeerEnabled,
    };
  },
)(HeaderMenuContainer));
