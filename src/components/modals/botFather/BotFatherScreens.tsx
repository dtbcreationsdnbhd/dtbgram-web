import type { ChangeEvent } from 'react';
import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { ApiBotCommand, ApiUser, ApiUserFullInfo } from '../../../api/types';
import type { IconName } from '../../../types/icons';
import type { RegularLangKey } from '../../../types/language';

import { getMainUsername, getUserFullName } from '../../../global/helpers';
import buildClassName from '../../../util/buildClassName';
import { copyTextToClipboard } from '../../../util/clipboard';
import { isUsernameValid } from '../../../util/entities/username';
import { debounce } from '../../../util/schedulers';
import stopEvent from '../../../util/stopEvent';
import { callApi } from '../../../api/gramjs';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Avatar from '../../common/Avatar';
import Icon from '../../common/icons/Icon';
import SafeLink from '../../common/SafeLink';
import Button from '../../ui/Button';
import ConfirmDialog from '../../ui/ConfirmDialog';
import DropdownMenu from '../../ui/DropdownMenu';
import MenuItem from '../../ui/MenuItem';
import SearchInput from '../../ui/SearchInput';
import Spinner from '../../ui/Spinner';
import Switcher from '../../ui/Switcher';

import styles from './BotFatherModal.module.scss';

const LEARN_MORE_URL = 'https://core.telegram.org/bots';
const DEVELOPER_TERMS_URL = 'https://telegram.org/tos/bot-developers';
const COMMANDS_LEARN_MORE_URL = 'https://core.telegram.org/bots/features#commands';
const COMMANDS_API_URL = 'https://core.telegram.org/bots/api#setmycommands';
const COMMANDS_SCOPE_URL = 'https://core.telegram.org/bots/features#command-scopes';
const MINI_APPS_URL = 'https://core.telegram.org/bots/webapps';
const MINI_APPS_MAIN_APP_URL = 'https://core.telegram.org/bots/webapps#main-mini-apps';
const MINI_APPS_DIRECT_LINKS_URL = 'https://core.telegram.org/bots/webapps#direct-link-mini-apps';
const BOTFATHER_PRIVACY_URL = 'https://t.me/BotFather?start=setprivacy';
const BOTFATHER_INLINE_URL = 'https://t.me/BotFather?start=setinline';
const BOTFATHER_DELETE_URL = 'https://t.me/BotFather?start=deletebot';
const BOTFATHER_SETJOINGROUP_URL = 'https://t.me/BotFather?start=setjoingroup';
const BOTFATHER_SETDOMAIN_URL = 'https://t.me/BotFather?start=setdomain';
const BOTFATHER_NEWAPP_URL = 'https://t.me/BotFather?start=newapp';
const BOTFATHER_NEWGAME_URL = 'https://t.me/BotFather?start=newgame';
const BOTFATHER_MYBOTS_URL = 'https://t.me/BotFather?start=mybots';
const BOTFATHER_TRANSFER_URL = 'https://t.me/BotFather?start=transferbot';
const USERNAME_SUFFIX = 'bot';
const MIN_USERNAME_LENGTH = 5;
const TOKEN_MASK = '••••••••••••';
const TOKEN_VISIBLE_CHARS = 4;
const CHECK_USERNAME_DEBOUNCE_MS = 250;

const runDebouncedForCheckUsername = debounce((cb: NoneToVoidFunction) => cb(), CHECK_USERNAME_DEBOUNCE_MS, false);

type HomeScreenProps = {
  botFather?: ApiUser;
  bots: ApiUser[];
  isLoading?: boolean;
  hasLoadError?: boolean;
};

type CreateScreenProps = {
  isCreating?: boolean;
  createError?: string;
};

type ManageScreenProps = {
  bot: ApiUser;
  botToken?: string;
  isLoadingToken?: boolean;
  isRevokingToken?: boolean;
  isDeletingBot?: boolean;
  isRunningManageCommand?: boolean;
};

type EditInfoScreenProps = {
  bot: ApiUser;
  name?: string;
  about?: string;
  description?: string;
  isSaving?: boolean;
};

type CommandsScreenProps = {
  bot: ApiUser;
  commands?: ApiBotCommand[];
};

type EditCommandScreenProps = {
  bot: ApiUser;
  commands?: ApiBotCommand[];
  commandIndex?: number;
  isSavingCommands?: boolean;
};

export type BotFatherDirectLinkItem = {
  shortName: string;
  title: string;
  description?: string;
  url?: string;
  photoUrl?: string;
};

type LaunchMode = 'compact' | 'fullsize' | 'fullscreen';

type MiniAppsScreenProps = {
  bot: ApiUser;
  fullInfo?: ApiUserFullInfo;
  directLinks?: BotFatherDirectLinkItem[];
  isSavingMiniApp?: boolean;
  editingShortName?: string;
  mainAppUrl?: string;
  mainAppLaunchMode?: LaunchMode;
};

const BotFatherHomeScreen = ({
  botFather,
  bots,
  isLoading,
  hasLoadError,
}: HomeScreenProps) => {
  const { setBotFatherModalView, openBotFatherManagedBot, loadAdminedBots } = getActions();

  const lang = useLang();

  const [searchQuery, setSearchQuery] = useState('');

  const filteredBots = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return bots;

    return bots.filter((bot) => {
      const title = getUserFullName(bot)?.toLowerCase() || '';
      const username = getMainUsername(bot)?.toLowerCase() || '';
      return title.includes(query) || username.includes(query);
    });
  }, [bots, searchQuery]);

  const handleOpenCreate = useLastCallback(() => {
    setBotFatherModalView({ view: 'create' });
  });

  const handleOpenBot = useLastCallback((botId: string) => {
    openBotFatherManagedBot({ botId });
  });

  const handleRetry = useLastCallback(() => {
    loadAdminedBots();
  });

  const handleResetSearch = useLastCallback(() => {
    setSearchQuery('');
  });

  function renderBotRow(bot: ApiUser) {
    const username = getMainUsername(bot);

    return (
      <button
        key={bot.id}
        type="button"
        className={styles.botRow}
        onClick={() => handleOpenBot(bot.id)}
      >
        <Avatar peer={bot} size="small" className={styles.rowAvatar} />
        <span className={styles.rowText}>
          <span className={styles.rowTitle}>{getUserFullName(bot)}</span>
          {username && <span className={styles.rowUsername}>{`@${username}`}</span>}
        </span>
        <Icon name="next" className={styles.rowChevron} />
      </button>
    );
  }

  function renderListState() {
    if (isLoading && !filteredBots.length) {
      return (
        <div className={styles.stateRow}>
          <Spinner />
        </div>
      );
    }

    if (hasLoadError) {
      return (
        <div className={styles.stateRow}>
          <span>{lang('BotFatherLoadError')}</span>
          <Button isText size="smaller" onClick={handleRetry}>{lang('BotFatherRefresh')}</Button>
        </div>
      );
    }

    if (!filteredBots.length) {
      return <div className={styles.stateRow}>{lang('BotFatherEmpty')}</div>;
    }

    return undefined;
  }

  return (
    <div className={styles.screen}>
      <div className={buildClassName(styles.scrollBody, 'custom-scroll')}>
        <div className={styles.hero}>
          <div className={buildClassName(styles.heroAvatar, styles.heroFallback)}>
            <Icon name="bots" className={styles.heroFallbackIcon} />
          </div>
          <h2 className={styles.heroTitle}>{lang('BotFatherTitle')}</h2>
          <p className={styles.heroSubtitle}>
            {lang('BotFatherSubtitleFull')}
            {' '}
            <SafeLink
              className={styles.link}
              url={LEARN_MORE_URL}
              text={lang('BotFatherLearnMore')}
              shouldSkipModal
            />
          </p>
        </div>

        <SearchInput
          className={styles.search}
          value={searchQuery}
          placeholder={lang('BotFatherSearch')}
          onChange={setSearchQuery}
          onReset={handleResetSearch}
        />

        <h3 className={styles.sectionTitle}>{lang('BotFatherMyBots')}</h3>
        <div className={styles.listGroup}>
          <button type="button" className={styles.createRow} onClick={handleOpenCreate}>
            <span className={styles.addIcon}>
              <Icon name="add" />
            </span>
            <span className={styles.createLabel}>{lang('BotFatherCreate')}</span>
            <Icon name="next" className={styles.rowChevron} />
          </button>
          {filteredBots.map(renderBotRow)}
          {renderListState()}
        </div>
        <p className={styles.groupFooter}>{lang('BotFatherFooter')}</p>
      </div>
    </div>
  );
};

const BotFatherCreateScreen = ({ isCreating, createError }: CreateScreenProps) => {
  const { createBotViaBotFather } = getActions();

  const lang = useLang();
  const fileInputRef = useRef<HTMLInputElement>();

  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [about, setAbout] = useState('');
  const [description, setDescription] = useState('');
  const [photo, setPhoto] = useState<File | undefined>();
  const [errorKey, setErrorKey] = useState<RegularLangKey | undefined>();
  const [checkedUsername, setCheckedUsername] = useState<string | undefined>();
  const [isUsernameAvailable, setIsUsernameAvailable] = useState<boolean | undefined>();
  const [isCheckingUsername, setIsCheckingUsername] = useState(false);

  const photoPreviewUrl = useObjectUrl(photo);

  const handlePickPhoto = useLastCallback(() => {
    fileInputRef.current?.click();
  });

  const handlePhotoChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setPhoto(file);
    e.target.value = '';
  });

  const handleNameChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
    setErrorKey(undefined);
  });

  const handleAboutChange = useLastCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setAbout(e.target.value);
  });

  const handleDescriptionChange = useLastCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setDescription(e.target.value);
  });

  const checkAvailability = useLastCallback(async (candidateUsername: string) => {
    try {
      const response = await callApi('checkUsername', candidateUsername);
      if (candidateUsername !== username) return;

      setIsCheckingUsername(false);
      setCheckedUsername(candidateUsername);
      setIsUsernameAvailable(response?.result === true);
    } catch {
      if (candidateUsername !== username) return;
      setIsCheckingUsername(false);
      setCheckedUsername(candidateUsername);
      setIsUsernameAvailable(undefined);
    }
  });

  const handleUsernameChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    const nextUsername = e.target.value.replace(/[^A-Za-z0-9_]/g, '');
    setUsername(nextUsername);
    setErrorKey(undefined);
    setIsUsernameAvailable(undefined);
    setCheckedUsername(undefined);

    const isSyntaxValid = nextUsername.length >= MIN_USERNAME_LENGTH
      && nextUsername.toLowerCase().endsWith(USERNAME_SUFFIX)
      && isUsernameValid(nextUsername, true);

    if (!isSyntaxValid) {
      setIsCheckingUsername(false);
      return;
    }

    setIsCheckingUsername(true);
    runDebouncedForCheckUsername(() => {
      checkAvailability(nextUsername);
    });
  });

  const isAvailableConfirmed = Boolean(
    username
    && checkedUsername === username
    && isUsernameAvailable === true
    && !isCheckingUsername,
  );

  const isTakenConfirmed = Boolean(
    username
    && checkedUsername === username
    && isUsernameAvailable === false
    && !isCheckingUsername,
  );

  const handleCreate = useLastCallback(() => {
    const trimmedName = name.trim();
    const trimmedUsername = username.trim();

    if (!trimmedName) {
      setErrorKey('BotFatherNameRequired');
      return;
    }
    if (trimmedUsername.length < MIN_USERNAME_LENGTH) {
      setErrorKey('BotFatherUsernameTooShort');
      return;
    }
    if (!trimmedUsername.toLowerCase().endsWith(USERNAME_SUFFIX)) {
      setErrorKey('BotFatherUsernameMustEndBot');
      return;
    }
    if (isTakenConfirmed || isUsernameAvailable === false) {
      setErrorKey('BotFatherUsernameTaken');
      return;
    }
    if (!isAvailableConfirmed) {
      return;
    }

    createBotViaBotFather({
      name: trimmedName,
      username: trimmedUsername,
      about: about.trim() || undefined,
      description: description.trim() || undefined,
      photo,
    });
  });

  const isUsernameError = Boolean(
    errorKey === 'BotFatherUsernameTooShort'
    || errorKey === 'BotFatherUsernameMustEndBot'
    || errorKey === 'BotFatherUsernameTaken',
  );

  const visibleUsernameErrorKey = (isUsernameError ? errorKey : undefined)
    || (isTakenConfirmed ? 'BotFatherUsernameTaken' : undefined);

  const generalErrorKey = (!isUsernameError ? errorKey : undefined)
    || (createError as RegularLangKey | undefined);

  return (
    <div className={buildClassName(styles.scrollBody, 'custom-scroll')}>
      {/* Profile Picture Uploader (Top Center): 84px circular avatar with camera badge */}
      <div className={styles.avatarUploader}>
        <button
          type="button"
          className={styles.avatarCircle}
          aria-label={lang('BotFatherSetPhoto')}
          onClick={handlePickPhoto}
        >
          {photoPreviewUrl ? (
            <img src={photoPreviewUrl} alt="" className={styles.avatarCircleImg} />
          ) : (
            <Icon name="camera-add" className={styles.avatarCircleIcon} />
          )}
        </button>
        <div className={styles.avatarBadge}>
          <Icon name="add" className={styles.avatarBadgeIcon} />
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png"
        className={styles.hiddenInput}
        onChange={handlePhotoChange}
      />

      <div className={styles.hero}>
        <h2 className={styles.heroTitle}>{lang('BotFatherNewBot')}</h2>
        <p className={styles.heroSubtitle}>{lang('BotFatherNewBotSubtitle')}</p>
      </div>

      {/* Inset Grouped Card 1: Bot Name & About */}
      <div className={styles.insetCard}>
        <div className={styles.cardFieldRow}>
          <input
            type="text"
            className={styles.cardFieldInput}
            value={name}
            maxLength={64}
            placeholder={lang('BotFatherNameLabel')}
            disabled={isCreating}
            onChange={handleNameChange}
          />
        </div>

        <div className={styles.cardSeparator} />

        <div className={styles.cardFieldRow}>
          <textarea
            className={styles.cardFieldTextarea}
            rows={1}
            value={about}
            placeholder={lang('BotFatherAboutOptional')}
            disabled={isCreating}
            onChange={handleAboutChange}
          />
        </div>
      </div>

      {/* Inset Grouped Card 2: Username with t.me/ prefix */}
      <div className={styles.insetCard}>
        <div className={styles.cardFieldRow}>
          <div className={styles.cardFieldInputWrapper}>
            <span className={styles.cardFieldPrefix}>t.me/</span>
            <input
              type="text"
              className={styles.cardFieldInput}
              value={username}
              maxLength={32}
              placeholder={lang('BotFatherUsernamePlaceholder')}
              disabled={isCreating}
              onChange={handleUsernameChange}
            />
            <div className={styles.cardFieldStatus}>
              {isCheckingUsername && <Spinner className={styles.rowSpinner} />}
              {isAvailableConfirmed && <Icon name="check" className={styles.statusCheck} />}
              {(isTakenConfirmed || visibleUsernameErrorKey) && (
                <Icon name="warning" className={styles.statusError} />
              )}
            </div>
          </div>
        </div>
      </div>

      {visibleUsernameErrorKey ? (
        <p className={styles.cardErrorCaption}>{lang(visibleUsernameErrorKey)}</p>
      ) : (
        <p className={styles.cardCaption}>{lang('BotFatherChooseUsernameHint')}</p>
      )}

      {/* Inset Grouped Card 3 (Optional Description): Description */}
      <div className={styles.insetCard}>
        <div className={styles.cardFieldRow}>
          <textarea
            className={styles.cardFieldTextarea}
            rows={2}
            value={description}
            placeholder={lang('BotFatherDescriptionLabel')}
            disabled={isCreating}
            onChange={handleDescriptionChange}
          />
        </div>
      </div>
      <p className={styles.cardCaption}>{lang('BotFatherDescriptionCaption')}</p>

      {generalErrorKey && <p className={styles.error}>{lang(generalErrorKey)}</p>}

      {/* Pinned Telegram MainButton */}
      <div className={styles.mainButtonWrapper}>
        <Button
          className={styles.mainButton}
          disabled={isCreating || !name.trim() || !isAvailableConfirmed}
          onClick={handleCreate}
        >
          {isCreating ? <Spinner color="white" /> : lang('BotFatherCreateSubmit')}
        </Button>
      </div>
    </div>
  );
};

const BotFatherManageScreen = ({
  bot,
  botToken,
  isLoadingToken,
  isRevokingToken,
  isDeletingBot,
  isRunningManageCommand,
}: ManageScreenProps) => {
  const {
    setBotFatherModalView,
    loadBotFatherEditInfo,
    loadBotFatherBotToken,
    revokeBotFatherBotToken,
    deleteBotViaBotFather,
    showNotification,
    openChatWithInfo,
    closeBotFatherModal,
  } = getActions();

  const lang = useLang();

  const [isTokenVisible, showToken, hideToken] = useFlag();
  const [isRevokeConfirmOpen, openRevokeConfirm, closeRevokeConfirm] = useFlag();
  const [isDeleteConfirmOpen, openDeleteConfirm, closeDeleteConfirm] = useFlag();

  const username = getMainUsername(bot);
  const isBusy = Boolean(isDeletingBot || isRunningManageCommand || isRevokingToken);

  const handleOpenBotProfile = useLastCallback((e: React.MouseEvent) => {
    stopEvent(e);
    closeBotFatherModal();
    openChatWithInfo({ id: bot.id });
  });

  const handleToggleToken = useLastCallback(() => {
    if (isTokenVisible) {
      hideToken();
    } else {
      showToken();
    }
  });

  const handleCopyToken = useLastCallback(() => {
    if (!botToken) return;

    copyTextToClipboard(botToken);
    showNotification({ message: { key: 'BotFatherTokenCopied' } });
  });

  const handleRevokeToken = useLastCallback(() => {
    closeRevokeConfirm();
    revokeBotFatherBotToken();
  });

  const handleOpenEditInfo = useLastCallback(() => {
    if (isBusy) {
      showNotification({ message: { key: 'BotFatherBusy' } });
      return;
    }
    loadBotFatherEditInfo();
  });

  const handleOpenCommands = useLastCallback(() => {
    if (isBusy) {
      showNotification({ message: { key: 'BotFatherBusy' } });
      return;
    }
    setBotFatherModalView({ view: 'commands' });
  });

  const handleOpenMiniApps = useLastCallback(() => {
    if (isBusy) {
      showNotification({ message: { key: 'BotFatherBusy' } });
      return;
    }
    setBotFatherModalView({ view: 'miniApps' });
  });

  const handleConfirmDelete = useLastCallback(() => {
    closeDeleteConfirm();
    window.open(BOTFATHER_DELETE_URL, '_blank', 'noopener');
    deleteBotViaBotFather();
  });

  function renderNavRow(
    icon: IconName,
    label: string,
    onClick: NoneToVoidFunction,
    options?: { badge?: string; destructive?: boolean; withPrimaryColor?: boolean; external?: boolean },
  ) {
    return (
      <button
        type="button"
        className={buildClassName(
          styles.navRow,
          options?.withPrimaryColor && styles.navRowPrimary,
          options?.destructive && styles.navRowDestructive,
        )}
        disabled={isBusy}
        onClick={onClick}
      >
        <Icon name={icon} className={styles.navIcon} />
        <span className={styles.navLabel}>
          {label}
          {options?.badge && <span className={styles.badge}>{options.badge}</span>}
        </span>
        {isBusy ? (
          <Spinner className={styles.rowSpinner} />
        ) : (
          <Icon name={options?.external ? 'next-link' : 'next'} className={styles.rowChevron} />
        )}
      </button>
    );
  }

  function renderToken() {
    if (isLoadingToken) {
      return (
        <>
          <Spinner className={styles.tokenSpinner} />
          <span className={styles.tokenPlaceholder}>{lang('BotFatherTokenLoading')}</span>
        </>
      );
    }

    if (!botToken) {
      return (
        <span className={styles.tokenPlaceholder}>
          {lang('BotFatherTokenMissing')}
          <Button isText size="smaller" onClick={() => loadBotFatherBotToken({})}>
            <Icon name="reload" />
          </Button>
        </span>
      );
    }

    return (
      <>
        <span className={styles.tokenValue}>
          {isTokenVisible ? botToken : `${botToken.slice(0, TOKEN_VISIBLE_CHARS)}${TOKEN_MASK}`}
        </span>
        <button
          type="button"
          className={styles.tokenEyeButton}
          aria-label={lang(isTokenVisible ? 'BotFatherTokenHide' : 'BotFatherTokenShow')}
          onClick={handleToggleToken}
        >
          <Icon name={isTokenVisible ? 'eye-crossed' : 'eye'} />
        </button>
      </>
    );
  }

  return (
    <div className={styles.screen}>
      <div className={buildClassName(styles.scrollBody, 'custom-scroll')}>
        <div className={styles.hero}>
          <Avatar peer={bot} size="jumbo" className={styles.heroAvatar} onClick={handleOpenBotProfile} />
          <h2 className={styles.heroTitle}>{getUserFullName(bot)}</h2>
          {username && (
            <button
              type="button"
              className={styles.heroUsername}
              onClick={handleOpenBotProfile}
            >
              {`@${username}`}
            </button>
          )}
        </div>

        <div className={styles.tokenCard}>
          <div className={styles.tokenInputRow}>
            <Icon name="key" className={styles.tokenIcon} />
            {renderToken()}
          </div>
          <div className={styles.tokenActions}>
            <Button
              className={styles.tokenCopyButton}
              disabled={!botToken}
              onClick={handleCopyToken}
            >
              {lang('BotFatherTokenCopy')}
            </Button>
            <Button
              className={styles.tokenRevokeButton}
              disabled={isLoadingToken || isRevokingToken}
              onClick={openRevokeConfirm}
            >
              {isRevokingToken ? <Spinner color="white" /> : lang('BotFatherTokenRevoke')}
            </Button>
          </div>
          <p className={styles.tokenHint}>
            {lang('BotFatherTokenHint')}
            {' '}
            <SafeLink
              className={styles.link}
              url={LEARN_MORE_URL}
              text={lang('BotFatherReadMore')}
              shouldSkipModal
            />
          </p>
        </div>

        <h3 className={styles.sectionTitle}>{lang('BotFatherSettings')}</h3>
        <div className={styles.listGroup}>
          {renderNavRow('info', lang('BotFatherEditInfo'), handleOpenEditInfo)}
          {renderNavRow('bot-command', lang('BotFatherCommands'), handleOpenCommands)}
          {renderNavRow('webapp', lang('BotFatherMiniApps'), handleOpenMiniApps)}
          {renderNavRow(
            'bots',
            lang('BotFatherBotSettings'),
            () => window.open(BOTFATHER_SETJOINGROUP_URL, '_blank', 'noopener'),
            { external: true },
          )}
          {renderNavRow(
            'key',
            lang('BotFatherLoginWidget'),
            () => window.open(BOTFATHER_SETDOMAIN_URL, '_blank', 'noopener'),
            { external: true },
          )}
          {renderNavRow(
            'cloud-download',
            lang('BotFatherServerless'),
            () => window.open(BOTFATHER_NEWAPP_URL, '_blank', 'noopener'),
            { badge: lang('BotFatherNewBadge'), external: true },
          )}
          {renderNavRow(
            'sport',
            lang('BotFatherGames'),
            () => window.open(BOTFATHER_NEWGAME_URL, '_blank', 'noopener'),
            { external: true },
          )}
        </div>

        <h3 className={styles.sectionTitle}>{lang('BotFatherMonetization')}</h3>
        <div className={styles.listGroup}>
          {renderNavRow(
            'cash-circle',
            lang('BotFatherPayments'),
            () => window.open(BOTFATHER_MYBOTS_URL, '_blank', 'noopener'),
            { external: true },
          )}
          {renderNavRow(
            'star',
            lang('BotFatherTelegramStars'),
            () => window.open(BOTFATHER_MYBOTS_URL, '_blank', 'noopener'),
            { external: true },
          )}
        </div>
        <p className={styles.groupHint}>
          {lang('BotFatherStarsHint')}
          {' '}
          <SafeLink
            className={styles.link}
            url={LEARN_MORE_URL}
            text={lang('BotFatherReadMore')}
            shouldSkipModal
          />
        </p>

        <h3 className={styles.sectionTitle}>{lang('BotFatherDangerZone')}</h3>
        <div className={buildClassName(styles.listGroup, styles.dangerZone)}>
          {renderNavRow(
            'lock',
            lang('BotFatherGroupPrivacy'),
            () => window.open(BOTFATHER_PRIVACY_URL, '_blank', 'noopener'),
            { external: true },
          )}
          {renderNavRow(
            'bot-command',
            lang('BotFatherInlineMode'),
            () => window.open(BOTFATHER_INLINE_URL, '_blank', 'noopener'),
            { external: true },
          )}
          {renderNavRow(
            'replace',
            lang('BotFatherTransfer'),
            () => window.open(BOTFATHER_TRANSFER_URL, '_blank', 'noopener'),
            { withPrimaryColor: true, external: true },
          )}
          {renderNavRow('delete', lang('BotFatherDeleteBot'), openDeleteConfirm, {
            destructive: true,
          })}
        </div>

        <p className={styles.groupFooter}>
          <SafeLink
            className={styles.link}
            url={DEVELOPER_TERMS_URL}
            text={lang('BotFatherDeveloperTerms')}
            shouldSkipModal
          />
        </p>
        <p className={styles.groupFooter}>{lang('BotFatherFooter')}</p>
      </div>

      <ConfirmDialog
        isOpen={isRevokeConfirmOpen}
        text={lang('BotFatherTokenRevokeConfirm')}
        confirmLabel={lang('BotFatherTokenRevoke')}
        confirmIsDestructive
        confirmHandler={handleRevokeToken}
        onClose={closeRevokeConfirm}
      />
      <ConfirmDialog
        isOpen={isDeleteConfirmOpen}
        text={lang('BotFatherDeleteConfirm')}
        confirmLabel={lang('BotFatherDeleteBot')}
        confirmIsDestructive
        confirmHandler={handleConfirmDelete}
        onClose={closeDeleteConfirm}
      />
    </div>
  );
};

const BotFatherEditInfoScreen = ({
  bot,
  name,
  about,
  description,
  isSaving,
}: EditInfoScreenProps) => {
  const { saveBotFatherEditInfo, showNotification } = getActions();

  const lang = useLang();
  const fileInputRef = useRef<HTMLInputElement>();
  const welcomeFileInputRef = useRef<HTMLInputElement>();

  const [editName, setEditName] = useState(name || '');
  const [editAbout, setEditAbout] = useState(about || '');
  const [editDescription, setEditDescription] = useState(description || '');
  const [photo, setPhoto] = useState<File | undefined>();
  const [welcomePhoto, setWelcomePhoto] = useState<File | undefined>();

  const photoPreviewUrl = useObjectUrl(photo);
  const welcomePhotoPreviewUrl = useObjectUrl(welcomePhoto);

  useEffect(() => {
    setEditName(name || '');
    setEditAbout(about || '');
    setEditDescription(description || '');
  }, [name, about, description]);

  const handlePickPhoto = useLastCallback(() => {
    fileInputRef.current?.click();
  });

  const handlePhotoChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setPhoto(file);
    e.target.value = '';
  });

  const handlePickWelcomePhoto = useLastCallback(() => {
    welcomeFileInputRef.current?.click();
  });

  const handleWelcomePhotoChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setWelcomePhoto(file);
    e.target.value = '';
  });

  const handleNameChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setEditName(e.target.value);
  });

  const handleAboutChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setEditAbout(e.target.value);
  });

  const handleDescriptionChange = useLastCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setEditDescription(e.target.value);
  });

  const handleSave = useLastCallback(() => {
    const trimmedName = editName.trim();
    if (!trimmedName) {
      showNotification({ message: { key: 'BotFatherNameRequired' } });
      return;
    }

    saveBotFatherEditInfo({
      name: trimmedName,
      about: editAbout.trim() || undefined,
      description: editDescription.trim() || undefined,
      photo,
    });
  });

  return (
    <div className={styles.editInfoWrapper}>
      <div className={buildClassName(styles.scrollBody, 'custom-scroll')}>
        <div className={styles.avatarSection}>
          <div className={styles.avatarWrapper}>
            {photoPreviewUrl ? (
              <img src={photoPreviewUrl} alt="" className={styles.photoPreview} />
            ) : (
              <Avatar peer={bot} size="giant" />
            )}
          </div>
          <button
            type="button"
            className={styles.setPhotoPill}
            onClick={handlePickPhoto}
          >
            <Icon name="camera-add" className={styles.setPhotoIcon} />
            <span>{lang('BotFatherSetPhoto')}</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className={styles.hiddenInput}
            onChange={handlePhotoChange}
          />
        </div>

        <div className={styles.infoHeaderRow}>
          <h3 className={styles.infoSectionTitle}>{lang('BotFatherInfo')}</h3>
          <div className={styles.commandsScopePill}>
            <Icon name="language" className={styles.commandsScopeIcon} />
            <span>{lang('BotFatherDefault')}</span>
            <Icon name="down" className={styles.commandsScopeChevron} />
          </div>
        </div>

        <div className={styles.infoCard}>
          <input
            type="text"
            className={styles.infoInput}
            value={editName}
            placeholder={lang('BotFatherNameLabel')}
            disabled={isSaving}
            onChange={handleNameChange}
          />
          <div className={styles.infoDivider} />
          <input
            type="text"
            className={styles.infoInput}
            value={editAbout}
            placeholder={lang('BotFatherAboutLabel')}
            disabled={isSaving}
            onChange={handleAboutChange}
          />
        </div>
        <p className={styles.infoHint}>
          {lang('BotFatherAboutHint')}
        </p>

        <h3 className={styles.welcomeSectionTitle}>{lang('BotFatherWelcomeSection')}</h3>

        <div className={styles.welcomeCard}>
          <div
            className={buildClassName(
              styles.welcomePictureBox,
              welcomePhotoPreviewUrl && styles.welcomePictureBoxHasImage,
            )}
            onClick={handlePickWelcomePhoto}
          >
            {welcomePhotoPreviewUrl ? (
              <img src={welcomePhotoPreviewUrl} alt="" className={styles.welcomePictureImg} />
            ) : (
              <Icon name="camera-add" className={styles.welcomePicturePlaceholderIcon} />
            )}
          </div>

          <h4 className={styles.welcomeBlockTitle}>{lang('BotFatherWhatCanThisBotDo')}</h4>

          <div className={styles.welcomeActionRow}>
            <button
              type="button"
              className={styles.setPhotoPill}
              onClick={handlePickWelcomePhoto}
            >
              <Icon name="camera-add" className={styles.setPhotoIcon} />
              <span>{lang('BotFatherSetWelcomePicture')}</span>
            </button>
          </div>
          <input
            ref={welcomeFileInputRef}
            type="file"
            accept="image/*,video/mp4"
            className={styles.hiddenInput}
            onChange={handleWelcomePhotoChange}
          />

          <div className={styles.welcomeInputWrapper}>
            <textarea
              className={styles.welcomeTextarea}
              value={editDescription}
              placeholder={lang('BotFatherEnterDescription')}
              rows={3}
              disabled={isSaving}
              onChange={handleDescriptionChange}
            />
          </div>
        </div>

        <p className={styles.welcomeHint}>
          {lang('BotFatherWelcomePictureHint')}
        </p>
        <p className={styles.welcomeHint}>
          {lang('BotFatherWelcomeFullHint')}
        </p>
      </div>

      <div className={styles.editInfoFooter}>
        <Button
          className={styles.updateSubmitButton}
          disabled={isSaving || !editName.trim()}
          onClick={handleSave}
        >
          {isSaving ? <Spinner color="white" /> : lang('BotFatherUpdate')}
        </Button>
      </div>
    </div>
  );
};

const BotFatherCommandsScreen = ({ bot, commands }: CommandsScreenProps) => {
  const { setBotFatherModalView, loadFullUser, saveBotFatherCommands } = getActions();
  const lang = useLang();

  const [isEditingList, setIsEditingList] = useState(false);

  useEffect(() => {
    loadFullUser({ userId: bot.id });
  }, [bot.id]);

  const handleToggleEditList = useLastCallback(() => {
    setIsEditingList((prev) => !prev);
  });

  const handleAddCommand = useLastCallback(() => {
    setBotFatherModalView({ view: 'newCommand' });
  });

  const handleEditCommand = useLastCallback((index: number) => {
    setBotFatherModalView({ view: 'editCommand', editingCommandIndex: index });
  });

  const handleDeleteCommand = useLastCallback((index: number) => {
    if (!commands) return;
    const nextCommands = commands
      .filter((_, i) => i !== index)
      .map(({ command: cmd, description: desc }) => ({ command: cmd, description: desc }));
    saveBotFatherCommands({ commands: nextCommands });
    if (nextCommands.length === 0) {
      setIsEditingList(false);
    }
  });

  const hasCommands = Boolean(commands && commands.length > 0);

  return (
    <div className={buildClassName(styles.scrollBody, 'custom-scroll')}>
      <div className={styles.commandsHero}>
        <div className={styles.commandIconBadge}>
          <span className={styles.commandIconSlash}>/</span>
        </div>
        <h2 className={styles.commandsHeroTitle}>{lang('BotFatherCommands')}</h2>
        <p className={styles.commandsHeroSubtitle}>
          {lang('BotFatherCommandsIntro')}
          {' '}
          <SafeLink
            className={styles.link}
            url={COMMANDS_LEARN_MORE_URL}
            text={lang('BotFatherReadMore')}
            shouldSkipModal
          />
        </p>
      </div>

      {hasCommands && (
        <div className={styles.commandsListHeader}>
          <h3 className={styles.commandsListTitle}>{lang('BotFatherList')}</h3>
          <div className={styles.commandsListActions}>
            <div className={styles.commandsScopePill}>
              <Icon name="language" className={styles.commandsScopeIcon} />
              <span>{lang('BotFatherDefault')}</span>
              <Icon name="down" className={styles.commandsScopeChevron} />
            </div>
            <button
              type="button"
              className={styles.commandsEditToggle}
              onClick={handleToggleEditList}
            >
              {lang(isEditingList ? 'BotFatherDone' : 'BotFatherEdit')}
            </button>
          </div>
        </div>
      )}

      {!isEditingList && (
        <div className={styles.addCommandCard}>
          <button
            type="button"
            className={styles.addCommandButtonRow}
            onClick={handleAddCommand}
          >
            {lang('BotFatherAddCommand')}
          </button>
        </div>
      )}

      {hasCommands && (
        <div className={styles.commandsCard}>
          {commands!.map((item, index) => (
            isEditingList ? (
              <div
                key={index}
                className={buildClassName(styles.commandItemRow, styles.commandItemRowEditing)}
              >
                <div className={styles.reorderHandle} aria-hidden="true">
                  <span className={styles.reorderBar} />
                  <span className={styles.reorderBar} />
                </div>
                <span className={styles.commandItemName}>{`/${item.command}`}</span>
                <span className={styles.commandItemDesc}>{item.description}</span>
                <button
                  type="button"
                  className={styles.deleteMinusButton}
                  aria-label={lang('BotFatherRemoveCommand')}
                  onClick={() => handleDeleteCommand(index)}
                >
                  <span className={styles.deleteMinusBar} />
                </button>
              </div>
            ) : (
              <button
                key={index}
                type="button"
                className={styles.commandItemRow}
                onClick={() => handleEditCommand(index)}
              >
                <span className={styles.commandItemName}>{`/${item.command}`}</span>
                <span className={styles.commandItemDesc}>{item.description}</span>
                <Icon name="next" className={styles.rowChevron} />
              </button>
            )
          ))}
        </div>
      )}

      <p className={styles.commandsApiNote}>
        {lang('BotFatherCommandsExploreApi')}
        {' '}
        <SafeLink
          className={styles.link}
          url={COMMANDS_API_URL}
          text={lang('BotFatherReadMore')}
          shouldSkipModal
        />
      </p>

      <div className={styles.commandsFooter}>
        {lang('BotFatherFooter')}
      </div>
    </div>
  );
};

const BotFatherEditCommandScreen = ({
  bot,
  commands,
  commandIndex,
  isSavingCommands,
}: EditCommandScreenProps) => {
  const { saveBotFatherCommands, showNotification } = getActions();
  const lang = useLang();

  const editingItem = commandIndex !== undefined ? commands?.[commandIndex] : undefined;
  const isEditing = Boolean(editingItem);
  const initialCommand = editingItem?.command || '';
  const initialDescription = editingItem?.description || '';

  const [command, setCommand] = useState(initialCommand);
  const [description, setDescription] = useState(initialDescription);
  const [scopeDirect, setScopeDirect] = useState(true);
  const [scopeGroups, setScopeGroups] = useState(true);
  const [scopeAdmins, setScopeAdmins] = useState(true);
  const [isEphemeral, setIsEphemeral] = useState(false);

  const handleCommandChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    const sanitized = raw.replace(/^\//, '').replace(/[^A-Za-z0-9_]/g, '').toLowerCase();
    setCommand(sanitized);
  });

  const handleDescriptionChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setDescription(e.target.value);
  });

  const handleSaveOrAdd = useLastCallback(() => {
    const cleanCommand = command.trim();
    const cleanDescription = description.trim();

    if (!cleanCommand || !cleanDescription) {
      showNotification({ message: { key: 'BotFatherCommandsError' } });
      return;
    }

    const currentCommands = commands
      ? commands.map(({ command: cmd, description: desc }) => ({ command: cmd, description: desc }))
      : [];

    if (isEditing) {
      currentCommands[commandIndex!] = {
        command: cleanCommand,
        description: cleanDescription,
      };
    } else {
      currentCommands.push({
        command: cleanCommand,
        description: cleanDescription,
      });
    }

    saveBotFatherCommands({ commands: currentCommands });
  });

  return (
    <div className={styles.editCommandWrapper}>
      <div className={buildClassName(styles.scrollBody, 'custom-scroll')}>
        <h3 className={styles.editCommandTitle}>
          {lang(isEditing ? 'BotFatherEditCommand' : 'BotFatherNewCommand')}
        </h3>

        <div className={styles.commandInputsCard}>
          <input
            type="text"
            className={styles.commandInput}
            value={command ? `/${command}` : ''}
            placeholder={lang('BotFatherCommandInputPlaceholder')}
            disabled={isSavingCommands}
            onChange={handleCommandChange}
          />
          <div className={styles.commandInputDivider} />
          <input
            type="text"
            className={styles.commandInput}
            value={description}
            placeholder={lang('BotFatherCommandDescription')}
            disabled={isSavingCommands}
            onChange={handleDescriptionChange}
          />
        </div>

        <h3 className={styles.scopeTitle}>{lang('BotFatherScope')}</h3>
        <div className={styles.scopeCard}>
          <div className={styles.toggleRow}>
            <span className={styles.toggleLabel}>{lang('BotFatherScopeDirect')}</span>
            <Switcher
              label={lang('BotFatherScopeDirect')}
              checked={scopeDirect}
              disabled={isSavingCommands}
              onCheck={setScopeDirect}
            />
          </div>
          <div className={styles.toggleDivider} />
          <div className={styles.toggleRow}>
            <span className={styles.toggleLabel}>{lang('BotFatherScopeGroups')}</span>
            <Switcher
              label={lang('BotFatherScopeGroups')}
              checked={scopeGroups}
              disabled={isSavingCommands}
              onCheck={setScopeGroups}
            />
          </div>
          <div className={styles.toggleDivider} />
          <div className={styles.toggleRow}>
            <span className={styles.toggleLabel}>{lang('BotFatherScopeAdmins')}</span>
            <Switcher
              label={lang('BotFatherScopeAdmins')}
              checked={scopeAdmins}
              disabled={isSavingCommands}
              onCheck={setScopeAdmins}
            />
          </div>
        </div>
        <p className={styles.scopeHint}>
          {lang('BotFatherScopeHint')}
          {' '}
          <SafeLink
            className={styles.link}
            url={COMMANDS_SCOPE_URL}
            text={lang('BotFatherReadMore')}
            shouldSkipModal
          />
        </p>

        <div className={styles.ephemeralCard}>
          <div className={styles.toggleRow}>
            <span className={styles.toggleLabel}>{lang('BotFatherEphemeral')}</span>
            <Switcher
              label={lang('BotFatherEphemeral')}
              checked={isEphemeral}
              disabled={isSavingCommands}
              onCheck={setIsEphemeral}
            />
          </div>
        </div>
        <p className={styles.ephemeralHint}>
          {lang('BotFatherEphemeralHint')}
        </p>
      </div>

      <div className={styles.editCommandFooter}>
        <Button
          className={styles.addCommandSubmitButton}
          disabled={isSavingCommands || !command.trim() || !description.trim()}
          onClick={handleSaveOrAdd}
        >
          {isSavingCommands ? <Spinner color="white" /> : lang(isEditing ? 'BotFatherSave' : 'BotFatherAdd')}
        </Button>
      </div>
    </div>
  );
};

const BotFatherMiniAppsScreen = ({
  bot, fullInfo, directLinks: modalDirectLinks, isSavingMiniApp,
}: MiniAppsScreenProps) => {
  const {
    setBotFatherModalView, showNotification, loadBotFatherDirectLinks, deleteBotFatherDirectLink,
  } = getActions();

  const lang = useLang();
  const botUsername = getMainUsername(bot) || 'bot';

  const initialMenuButtonEnabled = fullInfo?.botInfo?.menuButton?.type === 'webApp';
  const initialMainAppEnabled = Boolean(bot.hasMainMiniApp || fullInfo?.botInfo?.appSettings);

  const [hasSameOriginRestriction, setHasSameOriginRestriction] = useState(false);
  const [isMenuButtonEnabled, setIsMenuButtonEnabled] = useState(initialMenuButtonEnabled);
  const [isMainAppEnabled, setIsMainAppEnabled] = useState(initialMainAppEnabled);
  const [directLinks, setDirectLinks] = useState<BotFatherDirectLinkItem[]>(modalDirectLinks || []);
  const [isLoadingLinks, setIsLoadingLinks] = useState(!modalDirectLinks?.length);

  useEffect(() => {
    if (fullInfo?.botInfo?.menuButton) {
      setIsMenuButtonEnabled(fullInfo.botInfo.menuButton.type === 'webApp');
    }
  }, [fullInfo?.botInfo?.menuButton]);

  useEffect(() => {
    setIsMainAppEnabled(Boolean(bot.hasMainMiniApp || fullInfo?.botInfo?.appSettings));
  }, [bot.hasMainMiniApp, fullInfo?.botInfo?.appSettings]);

  useEffect(() => {
    if (modalDirectLinks) {
      setDirectLinks(modalDirectLinks);
      setIsLoadingLinks(false);
    }
  }, [modalDirectLinks]);

  useEffect(() => {
    let isCancelled = false;

    async function loadData() {
      const [menuButtonRes, accessSettingsRes, attachBotRes] = await Promise.all([
        callApi('fetchBotMenuButton', { bot }).catch(() => undefined),
        callApi('fetchBotAccessSettings', { bot }).catch(() => undefined),
        callApi('loadAttachBot', { bot }).catch(() => undefined),
      ]);

      if (isCancelled) return;

      if (menuButtonRes) {
        setIsMenuButtonEnabled(menuButtonRes.isEnabled);
      }
      if (accessSettingsRes) {
        setHasSameOriginRestriction(accessSettingsRes.isRestricted);
      }
      if (attachBotRes && attachBotRes.bot) {
        const attachBot = attachBotRes.bot;
        setIsMainAppEnabled(Boolean(bot.hasMainMiniApp || attachBot.isForSideMenu || attachBot.isForAttachMenu));
      }

      setIsLoadingLinks(true);
      loadBotFatherDirectLinks();
    }

    void loadData();

    return () => {
      isCancelled = true;
    };
  }, [bot, loadBotFatherDirectLinks]);

  const handleToggleSameOrigin = useLastCallback(async (isChecked: boolean) => {
    const previous = hasSameOriginRestriction;
    setHasSameOriginRestriction(isChecked);
    try {
      const result = await callApi('saveBotAccessSettings', {
        bot,
        isRestricted: isChecked,
      });
      if (!result) {
        setHasSameOriginRestriction(previous);
        showNotification({ message: lang('BotFatherAutomationError') });
        return;
      }

      const verified = await callApi('fetchBotAccessSettings', { bot }).catch(() => undefined);
      if (verified && verified.isRestricted !== isChecked) {
        setHasSameOriginRestriction(verified.isRestricted);
        showNotification({ message: lang('BotFatherAutomationError') });
        return;
      }

      showNotification({ message: lang('BotFatherInfoUpdated') });
    } catch {
      setHasSameOriginRestriction(previous);
      showNotification({ message: lang('BotFatherAutomationError') });
    }
  });

  const handleMenuButton = useLastCallback(() => {
    setBotFatherModalView({ view: 'miniAppMenuButton' });
  });

  const handleMainApp = useLastCallback(() => {
    setBotFatherModalView({ view: 'miniAppMainApp' });
  });

  const handleCreateDirectLink = useLastCallback(() => {
    setBotFatherModalView({ view: 'miniAppDirectLink', editingDirectLinkShortName: undefined });
  });

  const handleCopyLink = useLastCallback((item: BotFatherDirectLinkItem) => {
    copyTextToClipboard(`t.me/${botUsername}/${item.shortName}`);
    showNotification({ message: lang('BotFatherLinkCopied') });
  });

  const handleEditApp = useLastCallback((item: BotFatherDirectLinkItem) => {
    setBotFatherModalView({
      view: 'miniAppDirectLink',
      editingDirectLinkShortName: item.shortName,
    });
  });

  const handleDeleteApp = useLastCallback((item: BotFatherDirectLinkItem) => {
    deleteBotFatherDirectLink({ shortName: item.shortName });
  });

  return (
    <div className={buildClassName(styles.scrollBody, 'custom-scroll')}>
      <div className={styles.miniAppsHero}>
        <div className={styles.miniAppsHeroIcon}>
          <div className={styles.miniAppsHeroIconGrid} aria-hidden="true">
            <span className={styles.miniAppsHeroGridDot} />
            <span className={styles.miniAppsHeroGridDot} />
            <span className={styles.miniAppsHeroGridDot} />
            <span className={styles.miniAppsHeroGridDot} />
          </div>
        </div>
        <h2 className={styles.editCommandTitle}>{lang('BotFatherMiniApps')}</h2>
        <p className={styles.pageSubtitle}>
          {lang('BotFatherMiniAppsIntro')}
          {' '}
          <SafeLink url={MINI_APPS_URL} className={styles.link} text={lang('BotFatherReadMore')} shouldSkipModal />
        </p>
      </div>

      <div className={styles.listGroup}>
        <button type="button" className={styles.navRow} onClick={handleMenuButton}>
          <span className={styles.navLabel}>{lang('BotFatherMenuButton')}</span>
          <span className={buildClassName(styles.statusBadge, isMenuButtonEnabled && styles.statusBadgeEnabled)}>
            {isMenuButtonEnabled ? lang('BotFatherEnabled') : lang('BotFatherDisabled')}
          </span>
          <Icon name="next" className={styles.rowChevron} />
        </button>
        <button type="button" className={styles.navRow} onClick={handleMainApp}>
          <span className={styles.navLabel}>{lang('BotFatherMainApp')}</span>
          <span className={buildClassName(styles.statusBadge, isMainAppEnabled && styles.statusBadgeEnabled)}>
            {isMainAppEnabled ? lang('BotFatherEnabled') : lang('BotFatherDisabled')}
          </span>
          <Icon name="next" className={styles.rowChevron} />
        </button>
      </div>
      <p className={styles.groupHint}>
        {lang('BotFatherMainAppHint')}
        {' '}
        <SafeLink
          url={MINI_APPS_MAIN_APP_URL}
          className={styles.link}
          text={lang('BotFatherReadMore')}
          shouldSkipModal
        />
      </p>

      <div className={styles.scopeCard}>
        <div className={styles.sameOriginRow}>
          <div className={styles.sameOriginText}>
            <span className={styles.sameOriginTitle}>{lang('BotFatherSameOriginRestriction')}</span>
            <span className={styles.sameOriginDesc}>{lang('BotFatherSameOriginDesc')}</span>
          </div>
          <Switcher
            id="same-origin-restriction"
            label={lang('BotFatherSameOriginRestriction')}
            checked={hasSameOriginRestriction}
            onCheck={handleToggleSameOrigin}
          />
        </div>
      </div>
      <p className={styles.groupHint}>
        {lang('BotFatherSameOriginNotice')}
        {' '}
        <span className={styles.link}>
          {lang('BotFatherOptOut')}
        </span>
      </p>

      <h3 className={styles.scopeTitle}>{lang('BotFatherDirectLinks')}</h3>
      <div className={styles.directLinkCard}>
        <button
          type="button"
          className={styles.directLinkCreateRow}
          disabled={isSavingMiniApp}
          onClick={handleCreateDirectLink}
        >
          <div className={styles.directLinkPlusCircle}>
            <Icon name="add" />
          </div>
          <span className={styles.directLinkCreateLabel}>{lang('BotFatherCreateDirectLink')}</span>
        </button>

        {(isLoadingLinks || isSavingMiniApp) && !directLinks.length && (
          <div className={styles.directLinkRow}>
            <div className={styles.directLinkDivider} />
            <div className={styles.directLinkRowContent}>
              <Spinner />
            </div>
          </div>
        )}

        {directLinks.map((item) => (
          <div key={item.shortName} className={styles.directLinkRow}>
            <div className={styles.directLinkDivider} />
            <div className={styles.directLinkRowContent}>
              <div className={styles.directLinkThumb}>
                {item.photoUrl ? (
                  <img src={item.photoUrl} alt="" className={styles.directLinkThumbImg} />
                ) : (
                  <div className={styles.directLinkThumbFallback}>
                    <div className={styles.directLinkMockupLines}>
                      <span className={styles.directLinkMockupLine} />
                      <span className={styles.directLinkMockupLine} />
                      <span className={styles.directLinkMockupLine} />
                    </div>
                  </div>
                )}
              </div>
              <div className={styles.directLinkInfo}>
                <span className={styles.directLinkTitle}>{item.title}</span>
                <span className={styles.directLinkUrl}>{`t.me/${botUsername}/${item.shortName}`}</span>
              </div>
              <DropdownMenu positionX="right" withPortal>
                <MenuItem
                  icon="copy"
                  onClick={() => handleCopyLink(item)}
                >
                  {lang('BotFatherCopyLink')}
                </MenuItem>
                <MenuItem
                  icon="edit"
                  onClick={() => handleEditApp(item)}
                >
                  {lang('BotFatherEditApp')}
                </MenuItem>
                <MenuItem
                  icon="delete"
                  destructive
                  disabled={isSavingMiniApp}
                  onClick={() => handleDeleteApp(item)}
                >
                  {lang('BotFatherDeleteApp')}
                </MenuItem>
              </DropdownMenu>
            </div>
          </div>
        ))}
      </div>
      <p className={styles.groupHint}>
        {lang('BotFatherDirectLinksHint')}
        {' '}
        <SafeLink
          url={MINI_APPS_DIRECT_LINKS_URL}
          className={styles.link}
          text={lang('BotFatherReadMore')}
          shouldSkipModal
        />
      </p>

      <p className={styles.footerNote}>{lang('BotFatherOfficialHandle')}</p>
    </div>
  );
};

const BotFatherMenuButtonScreen = ({ bot, fullInfo, isSavingMiniApp }: MiniAppsScreenProps) => {
  const {
    showNotification, saveBotFatherMenuButton, disableBotFatherMenuButton,
  } = getActions();
  const lang = useLang();

  const webAppMenuButton = fullInfo?.botInfo?.menuButton?.type === 'webApp'
    ? fullInfo.botInfo.menuButton
    : undefined;

  const [url, setUrl] = useState(webAppMenuButton?.url || '');
  const [title, setTitle] = useState(webAppMenuButton?.text || '');
  const [hasCustomButton, setHasCustomButton] = useState(Boolean(webAppMenuButton));

  useEffect(() => {
    if (webAppMenuButton) {
      if (webAppMenuButton.url) setUrl(webAppMenuButton.url);
      if (webAppMenuButton.text) setTitle(webAppMenuButton.text);
      setHasCustomButton(true);
    }
  }, [webAppMenuButton]);

  useEffect(() => {
    let isCancelled = false;

    async function loadMenuButton() {
      const res = await callApi('fetchBotMenuButton', { bot }).catch(() => undefined);
      if (isCancelled || !res) return;

      if (res.url) {
        setUrl(res.url);
      }
      if (res.text) {
        setTitle(res.text);
      }
      setHasCustomButton(Boolean(res.isEnabled));
    }

    void loadMenuButton();

    return () => {
      isCancelled = true;
    };
  }, [bot]);

  const handleUrlChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setUrl(e.target.value);
  });

  const handleTitleChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setTitle(e.target.value);
  });

  const handleSave = useLastCallback(() => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      showNotification({ message: lang('BotFatherEnterUrl') });
      return;
    }

    saveBotFatherMenuButton({
      url: trimmedUrl,
      text: title.trim() || undefined,
    });
  });

  const handleDisableMenuButton = useLastCallback(() => {
    disableBotFatherMenuButton();
  });

  return (
    <div className={styles.screen}>
      <div className={buildClassName(styles.scrollBody, 'custom-scroll')}>
        <h2 className={styles.miniAppSubScreenTitle}>{lang('BotFatherMenuButton')}</h2>

        <div className={styles.menuButtonPreviewCard}>
          <div className={styles.menuButtonPreviewPill}>
            <Icon name="webapp" className={styles.menuButtonPreviewPillIcon} />
            <span>{title.trim() || lang('BotFatherOpen')}</span>
          </div>
        </div>

        <div className={buildClassName(styles.commandInputsCard, 'mt-3')}>
          <input
            type="text"
            className={styles.commandInput}
            placeholder={lang('BotFatherEnterUrl')}
            value={url}
            disabled={isSavingMiniApp}
            onChange={handleUrlChange}
          />
          <div className={styles.commandInputDivider} />
          <input
            type="text"
            className={styles.commandInput}
            placeholder={lang('BotFatherEnterTitle')}
            value={title}
            disabled={isSavingMiniApp}
            onChange={handleTitleChange}
          />
        </div>

        <p className={styles.groupHint}>
          {lang('BotFatherMenuButtonHint')}
        </p>

        {hasCustomButton && (
          <div className={styles.disableMenuButtonCard}>
            <button
              type="button"
              className={styles.disableMenuButton}
              disabled={isSavingMiniApp}
              onClick={handleDisableMenuButton}
            >
              {lang('BotFatherDisableMenuButton')}
            </button>
          </div>
        )}
      </div>

      <div className={styles.editInfoFooter}>
        <Button
          className={styles.updateSubmitButton}
          disabled={isSavingMiniApp}
          onClick={handleSave}
        >
          {isSavingMiniApp ? <Spinner color="white" /> : lang('BotFatherSave')}
        </Button>
      </div>
    </div>
  );
};

const BotFatherMainAppScreen = ({
  bot, isSavingMiniApp, mainAppUrl, mainAppLaunchMode,
}: MiniAppsScreenProps) => {
  const {
    showNotification, saveBotFatherMainApp, disableBotFatherMainApp,
  } = getActions();
  const lang = useLang();

  const [url, setUrl] = useState(mainAppUrl || '');
  const [launchMode, setLaunchMode] = useState<LaunchMode>(mainAppLaunchMode || 'compact');

  useEffect(() => {
    if (mainAppUrl !== undefined) {
      setUrl(mainAppUrl);
    }
  }, [mainAppUrl]);

  useEffect(() => {
    if (mainAppLaunchMode) {
      setLaunchMode(mainAppLaunchMode);
    }
  }, [mainAppLaunchMode]);

  const hasMainApp = Boolean(bot.hasMainMiniApp || url.trim());

  const handleUrlChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setUrl(e.target.value);
  });

  const handleSelectCompact = useLastCallback(() => {
    setLaunchMode('compact');
  });

  const handleSelectFullsize = useLastCallback(() => {
    setLaunchMode('fullsize');
  });

  const handleSelectFullscreen = useLastCallback(() => {
    setLaunchMode('fullscreen');
  });

  const handleSave = useLastCallback(() => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      showNotification({ message: lang('BotFatherEnterUrl') });
      return;
    }

    saveBotFatherMainApp({
      url: trimmedUrl,
      launchMode,
    });
  });

  const handleDisable = useLastCallback(() => {
    disableBotFatherMainApp();
  });

  return (
    <div className={styles.screen}>
      <div className={buildClassName(styles.scrollBody, 'custom-scroll')}>
        <h2 className={styles.miniAppSubScreenTitle}>{lang('BotFatherMainApp')}</h2>

        <div className={styles.commandInputsCard}>
          <input
            type="text"
            className={styles.commandInput}
            placeholder={lang('BotFatherEnterUrl')}
            value={url}
            disabled={isSavingMiniApp}
            onChange={handleUrlChange}
          />
        </div>
        <p className={styles.groupHint}>
          {lang('BotFatherMainAppUrlHint')}
        </p>

        <h3 className={styles.scopeTitle}>{lang('BotFatherLaunchMode')}</h3>
        <div className={styles.launchModesGrid}>
          <button type="button" className={styles.launchModeOption} onClick={handleSelectCompact}>
            <div className={styles.phoneMockup}>
              <div className={styles.phoneNotch} />
              <div className={styles.phoneMockupCompactFill} />
            </div>
            <span
              className={buildClassName(
                styles.launchModeLabel,
                launchMode === 'compact' && styles.launchModeLabelSelected,
              )}
            >
              {lang('BotFatherLaunchModeCompact')}
            </span>
          </button>

          <button type="button" className={styles.launchModeOption} onClick={handleSelectFullsize}>
            <div className={buildClassName(styles.phoneMockup, styles.phoneMockupFullsize)}>
              <div className={styles.phoneNotch} />
              <Icon name="arrow-left" className={styles.phoneArrowLeft} />
            </div>
            <span
              className={buildClassName(
                styles.launchModeLabel,
                launchMode === 'fullsize' && styles.launchModeLabelSelected,
              )}
            >
              {lang('BotFatherLaunchModeFullsize')}
            </span>
          </button>

          <button type="button" className={styles.launchModeOption} onClick={handleSelectFullscreen}>
            <div className={buildClassName(styles.phoneMockup, styles.phoneMockupFullscreen)}>
              <div className={styles.phoneNotch} />
            </div>
            <span
              className={buildClassName(
                styles.launchModeLabel,
                launchMode === 'fullscreen' && styles.launchModeLabelSelected,
              )}
            >
              {lang('BotFatherLaunchModeFullscreen')}
            </span>
          </button>
        </div>

        <div className={styles.launchScreenCard}>
          <button type="button" className={styles.navRow}>
            <span className={styles.navLabel}>{lang('BotFatherLaunchScreen')}</span>
            <Icon name="next" className={styles.rowChevron} />
          </button>
        </div>
        <p className={styles.groupHint}>
          {lang('BotFatherLaunchScreenHint')}
        </p>

        {hasMainApp && (
          <div className={styles.disableMenuButtonCard}>
            <button
              type="button"
              className={styles.disableMenuButton}
              disabled={isSavingMiniApp}
              onClick={handleDisable}
            >
              {lang('BotFatherDisableMainApp')}
            </button>
          </div>
        )}
      </div>

      <div className={styles.editInfoFooter}>
        <Button
          className={styles.updateSubmitButton}
          disabled={isSavingMiniApp}
          onClick={handleSave}
        >
          {isSavingMiniApp ? <Spinner color="white" /> : lang('BotFatherSave')}
        </Button>
      </div>
    </div>
  );
};

const BotFatherDirectLinkScreen = ({
  bot, isSavingMiniApp, editingShortName, directLinks,
}: MiniAppsScreenProps) => {
  const { showNotification, createBotFatherDirectLink } = getActions();
  const lang = useLang();
  const fileInputRef = useRef<HTMLInputElement>();

  const existing = editingShortName
    ? directLinks?.find((item) => item.shortName.toLowerCase() === editingShortName.toLowerCase())
    : undefined;

  const [url, setUrl] = useState(existing?.url || '');
  const [title, setTitle] = useState(existing?.title || '');
  const [description, setDescription] = useState(existing?.description || '');
  const [shortName, setShortName] = useState(editingShortName || '');
  const [photo, setPhoto] = useState<File | undefined>();

  const photoPreviewUrl = useObjectUrl(photo) || existing?.photoUrl;
  const botUsername = getMainUsername(bot) || 'bot';
  const isEditing = Boolean(editingShortName);

  const handleUrlChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setUrl(e.target.value);
  });

  const handleTitleChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setTitle(e.target.value);
  });

  const handleDescriptionChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setDescription(e.target.value);
  });

  const handleShortNameChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    if (isEditing) return;
    setShortName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''));
  });

  const handlePickPhoto = useLastCallback(() => {
    fileInputRef.current?.click();
  });

  const handlePhotoChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setPhoto(file);
    e.target.value = '';
  });

  const handleCreate = useLastCallback(() => {
    const cleanShortName = shortName.trim().toLowerCase();
    const trimmedUrl = url.trim();
    if (!cleanShortName) {
      showNotification({ message: lang('BotFatherChooseLinkHint') });
      return;
    }
    if (!trimmedUrl) {
      showNotification({ message: lang('BotFatherEnterUrl') });
      return;
    }
    if (!isEditing && !photo) {
      showNotification({ message: lang('BotFatherPhotoRequired') });
      return;
    }

    createBotFatherDirectLink({
      url: trimmedUrl,
      title: title.trim() || cleanShortName,
      description: description.trim() || title.trim() || cleanShortName,
      shortName: cleanShortName,
      photo,
    });
  });

  return (
    <div className={styles.screen}>
      <div className={buildClassName(styles.scrollBody, 'custom-scroll')}>
        <h2 className={styles.miniAppSubScreenTitle}>
          {isEditing ? lang('BotFatherEditApp') : lang('BotFatherDirectLink')}
        </h2>

        <div className={styles.commandInputsCard}>
          <input
            type="text"
            className={styles.commandInput}
            placeholder={lang('BotFatherEnterUrl')}
            value={url}
            disabled={isSavingMiniApp}
            onChange={handleUrlChange}
          />
        </div>

        <h3 className={styles.scopeTitle}>{lang('BotFatherMetadata')}</h3>
        <div className={styles.metadataCard}>
          <div className={styles.metadataPreviewBox}>
            <div className={styles.metadataDottedBox}>
              {photoPreviewUrl ? (
                <img src={photoPreviewUrl} alt="" className={styles.metadataCoverImg} />
              ) : (
                <Icon name="camera-add" className={styles.metadataDottedIcon} />
              )}
            </div>
            <div className={styles.metadataPreviewText}>
              <span className={styles.metadataPreviewTitle}>
                {title.trim() || lang('BotFatherDirectLinkTitlePlaceholder')}
              </span>
              <span className={styles.metadataPreviewDesc}>
                {description.trim() || lang('BotFatherDirectLinkDescPlaceholder')}
              </span>
            </div>
          </div>

          <button
            type="button"
            className={styles.metadataSetPhotoPill}
            disabled={isSavingMiniApp}
            onClick={handlePickPhoto}
          >
            <Icon name="camera-add" className={styles.metadataSetPhotoIcon} />
            <span>{lang('BotFatherSetPhotoOrGif')}</span>
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,image/gif"
          className={styles.hiddenFileInput}
          onChange={handlePhotoChange}
        />

        <div className={buildClassName(styles.commandInputsCard, 'mt-3')}>
          <input
            type="text"
            className={styles.commandInput}
            placeholder={lang('BotFatherDirectLinkTitlePlaceholder')}
            value={title}
            disabled={isSavingMiniApp}
            onChange={handleTitleChange}
          />
          <div className={styles.commandInputDivider} />
          <input
            type="text"
            className={styles.commandInput}
            placeholder={lang('BotFatherDirectLinkDescPlaceholder')}
            value={description}
            disabled={isSavingMiniApp}
            onChange={handleDescriptionChange}
          />
        </div>

        <p className={styles.groupHint}>
          {lang('BotFatherDirectLinkMetadataHint')}
        </p>

        <div className={styles.shortNameRow}>
          <span className={styles.shortNamePrefix}>{`t.me/${botUsername}/`}</span>
          <input
            type="text"
            className={styles.shortNameInput}
            placeholder={lang('BotFatherDirectLinkShortNamePlaceholder')}
            value={shortName}
            disabled={isSavingMiniApp || isEditing}
            onChange={handleShortNameChange}
          />
        </div>
        <p className={styles.groupHint}>
          {lang('BotFatherChooseLinkHint')}
        </p>
      </div>

      <div className={styles.editInfoFooter}>
        <Button
          className={styles.updateSubmitButton}
          disabled={isSavingMiniApp}
          onClick={handleCreate}
        >
          {isSavingMiniApp
            ? <Spinner color="white" />
            : lang(isEditing ? 'BotFatherSave' : 'BotFatherCreateButton')}
        </Button>
      </div>
    </div>
  );
};

function useObjectUrl(file?: File) {
  const [url, setUrl] = useState<string | undefined>();

  useEffect(() => {
    if (!file) {
      setUrl(undefined);
      return undefined;
    }

    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);

    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return url;
}

export const HomeScreen = memo(BotFatherHomeScreen);
export const CreateScreen = memo(BotFatherCreateScreen);
export const ManageScreen = memo(BotFatherManageScreen);
export const EditInfoScreen = memo(BotFatherEditInfoScreen);
export const CommandsScreen = memo(BotFatherCommandsScreen);
export const EditCommandScreen = memo(BotFatherEditCommandScreen);
export const MiniAppsScreen = memo(BotFatherMiniAppsScreen);
export const MenuButtonScreen = memo(BotFatherMenuButtonScreen);
export const MainAppScreen = memo(BotFatherMainAppScreen);
export const DirectLinkScreen = memo(BotFatherDirectLinkScreen);
