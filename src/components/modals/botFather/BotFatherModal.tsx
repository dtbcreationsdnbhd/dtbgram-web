import { memo, useMemo } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiBotCommand, ApiUser } from '../../../api/types';
import type { TabState } from '../../../global/types';

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
  CommandsScreen, CreateScreen, EditCommandScreen, EditInfoScreen, HomeScreen, ManageScreen, MiniAppsScreen,
} from './BotFatherScreens';

import styles from './BotFatherModal.module.scss';

export type OwnProps = {
  modal: TabState['botFatherModal'];
};

type StateProps = {
  usersById: Record<string, ApiUser>;
  selectedBot?: ApiUser;
  botFather?: ApiUser;
  selectedBotCommands?: ApiBotCommand[];
};

const BotFatherModal = ({
  modal,
  usersById,
  selectedBot,
  botFather,
  selectedBotCommands,
}: OwnProps & StateProps) => {
  const {
    closeBotFatherModal,
    setBotFatherModalView,
    loadAdminedBots,
    startBotFatherConversation,
  } = getActions();

  const lang = useLang();

  const renderingModal = useCurrentOrPrev(modal, true);
  const isOpen = Boolean(modal);
  const view = renderingModal?.view || 'home';
  const isBusy = Boolean(
    renderingModal?.isCreating
    || renderingModal?.isSaving
    || renderingModal?.isSavingCommands
    || renderingModal?.isDeletingBot
    || renderingModal?.isRunningManageCommand,
  );
  const adminedBotIds = renderingModal?.adminedBotIds;

  const bots = useMemo(() => (
    adminedBotIds?.map((id) => usersById[id]).filter(Boolean) || []
  ), [adminedBotIds, usersById]);

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
          <span className={styles.headerTitleText}>{lang('BotFatherTitle')}</span>
          <VerifiedIcon />
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
        return selectedBot ? <MiniAppsScreen bot={selectedBot} /> : undefined;
      default:
        return (
          <HomeScreen
            botFather={botFather}
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
    botFather: modal?.botFatherId ? selectUser(global, modal.botFatherId) : undefined,
    selectedBotCommands: selectedBotId
      ? selectUserFullInfo(global, selectedBotId)?.botInfo?.commands
      : undefined,
  };
})(BotFatherModal));
