import { memo, useMemo } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiBotCommand, ApiUser, ApiUserFullInfo } from '../../../api/types';
import type { TabState } from '../../../global/types';

import { MANAGER_BOT_USER_ID } from '../../../config';
import { getUserFullName } from '../../../global/helpers';
import { selectUser, selectUserFullInfo } from '../../../global/selectors';
import buildClassName from '../../../util/buildClassName';

import useCurrentOrPrev from '../../../hooks/useCurrentOrPrev';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import VerifiedIcon from '../../common/VerifiedIcon';
import Button from '../../ui/Button';
import DropdownMenu from '../../ui/DropdownMenu';
import MenuItem from '../../ui/MenuItem';
import Modal from '../../ui/Modal';
import {
  CommandsScreen,
  CreateScreen,
  DirectLinkScreen,
  EditCommandScreen,
  EditInfoScreen,
  HomeScreen,
  MainAppScreen,
  ManageScreen,
  MenuButtonScreen,
  MiniAppsScreen,
} from './BotFatherScreens';

import styles from './BotFatherModal.module.scss';

export type OwnProps = {
  modal: TabState['botFatherModal'];
};

type StateProps = {
  usersById: Record<string, ApiUser>;
  selectedBot?: ApiUser;
  managerBot?: ApiUser;
  selectedBotCommands?: ApiBotCommand[];
  selectedBotFullInfo?: ApiUserFullInfo;
};

const BotFatherModal = ({
  modal,
  usersById,
  selectedBot,
  managerBot,
  selectedBotCommands,
  selectedBotFullInfo,
}: OwnProps & StateProps) => {
  const {
    closeBotFatherModal,
    setBotFatherModalView,
    loadAdminedBots,
    startBotFatherConversation,
  } = getActions();

  const lang = useLang();

  const isOpen = Boolean(modal);
  const renderingModal = useCurrentOrPrev(modal, true);
  const {
    view = 'home',
    adminedBotIds,
  } = renderingModal || {};

  const isBusy = Boolean(
    modal?.isLoading
    || modal?.isCreating
    || modal?.isLoadingToken
    || modal?.isRevokingToken
    || modal?.isDeletingBot
    || modal?.isSaving
    || modal?.isSavingCommands
    || modal?.isSavingMiniApp
    || modal?.isRunningManageCommand,
  );

  const bots = useMemo(() => {
    if (!adminedBotIds) return [];
    return adminedBotIds.map((id) => usersById[id]).filter(Boolean);
  }, [adminedBotIds, usersById]);

  const handleClose = useLastCallback(() => {
    if (isBusy) return;

    closeBotFatherModal();
  });

  const handleBack = useLastCallback(() => {
    if (isBusy) return;

    if (view === 'newCommand' || view === 'editCommand') {
      setBotFatherModalView({ view: 'commands' });
      return;
    }

    if (view === 'miniAppMenuButton' || view === 'miniAppMainApp' || view === 'miniAppDirectLink') {
      setBotFatherModalView({ view: 'miniApps' });
      return;
    }

    const isTopLevelView = view === 'create' || view === 'manage';
    setBotFatherModalView({ view: isTopLevelView ? 'home' : 'manage' });
  });

  const handleRefresh = useLastCallback(() => {
    loadAdminedBots();
  });

  const handleOpenBotFatherChat = useLastCallback(() => {
    closeBotFatherModal();
    startBotFatherConversation({});
  });

  function renderHeader() {
    return (
      <div className={styles.header}>
        {view === 'home' ? (
          <div className={styles.headerSpacer} />
        ) : (
          <Button
            round
            size="smaller"
            color="translucent"
            ariaLabel={lang('BotFatherBack')}
            disabled={isBusy}
            onClick={handleBack}
          >
            <Icon name="arrow-left" />
          </Button>
        )}
        <div className={styles.headerTitle}>
          <span className={styles.headerTitleText}>
            {managerBot ? getUserFullName(managerBot) : 'BotBrother'}
          </span>
          {managerBot?.isVerified && <VerifiedIcon />}
        </div>
        <DropdownMenu positionX="right" withPortal>
          <MenuItem icon="reload" onClick={handleRefresh}>{lang('BotFatherRefresh')}</MenuItem>
          <MenuItem icon="bots" onClick={handleOpenBotFatherChat}>{lang('BotFatherOpenChat')}</MenuItem>
        </DropdownMenu>
        <Button
          round
          size="smaller"
          color="translucent"
          ariaLabel={lang('Close')}
          disabled={isBusy}
          onClick={handleClose}
        >
          <Icon name="close" />
        </Button>
      </div>
    );
  }

  function renderScreen(state: NonNullable<TabState['botFatherModal']>) {
    switch (state.view) {
      case 'create':
        return <CreateScreen isCreating={state.isCreating} createError={state.createError} />;
      case 'manage':
        return selectedBot ? (
          <ManageScreen
            bot={selectedBot}
            botToken={state.botToken}
            isLoadingToken={state.isLoadingToken}
            isRevokingToken={state.isRevokingToken}
            isDeletingBot={state.isDeletingBot}
            isRunningManageCommand={state.isRunningManageCommand}
          />
        ) : undefined;
      case 'editInfo':
        return selectedBot ? (
          <EditInfoScreen
            bot={selectedBot}
            name={state.editName}
            about={state.editAbout}
            description={state.editDescription}
            isSaving={state.isSaving}
          />
        ) : undefined;
      case 'commands':
        return selectedBot ? (
          <CommandsScreen
            bot={selectedBot}
            commands={selectedBotCommands}
          />
        ) : undefined;
      case 'newCommand':
      case 'editCommand':
        return selectedBot ? (
          <EditCommandScreen
            bot={selectedBot}
            commands={selectedBotCommands}
            commandIndex={state.editingCommandIndex}
            isSavingCommands={state.isSavingCommands}
          />
        ) : undefined;
      case 'miniApps':
        return selectedBot ? (
          <MiniAppsScreen
            bot={selectedBot}
            fullInfo={selectedBotFullInfo}
            directLinks={state.directLinks}
            isSavingMiniApp={state.isSavingMiniApp}
          />
        ) : undefined;
      case 'miniAppMenuButton':
        return selectedBot ? (
          <MenuButtonScreen
            bot={selectedBot}
            fullInfo={selectedBotFullInfo}
            isSavingMiniApp={state.isSavingMiniApp}
          />
        ) : undefined;
      case 'miniAppMainApp':
        return selectedBot ? (
          <MainAppScreen
            bot={selectedBot}
            fullInfo={selectedBotFullInfo}
            isSavingMiniApp={state.isSavingMiniApp}
            mainAppUrl={state.mainAppUrl}
            mainAppLaunchMode={state.mainAppLaunchMode}
          />
        ) : undefined;
      case 'miniAppDirectLink':
        return selectedBot ? (
          <DirectLinkScreen
            bot={selectedBot}
            isSavingMiniApp={state.isSavingMiniApp}
            editingShortName={state.editingDirectLinkShortName}
            directLinks={state.directLinks}
          />
        ) : undefined;
      default:
        return (
          <HomeScreen
            botFather={managerBot}
            bots={bots}
            isLoading={state.isLoading}
            hasLoadError={state.hasLoadError}
          />
        );
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      className={buildClassName(styles.modal, 'tall')}
      contentClassName={styles.content}
      isSlim
      onClose={handleClose}
    >
      {renderingModal ? (
        <div className={styles.root}>
          {renderHeader()}
          {renderScreen(renderingModal)}
        </div>
      ) : undefined}
    </Modal>
  );
};

export default memo(withGlobal<OwnProps>((global, { modal }): Complete<StateProps> => {
  const selectedBotId = modal?.selectedBotId;

  return {
    usersById: global.users.byId,
    selectedBot: selectedBotId ? selectUser(global, selectedBotId) : undefined,
    managerBot: selectUser(global, MANAGER_BOT_USER_ID),
    selectedBotCommands: selectedBotId
      ? selectUserFullInfo(global, selectedBotId)?.botInfo?.commands
      : undefined,
    selectedBotFullInfo: selectedBotId ? selectUserFullInfo(global, selectedBotId) : undefined,
  };
})(BotFatherModal));
