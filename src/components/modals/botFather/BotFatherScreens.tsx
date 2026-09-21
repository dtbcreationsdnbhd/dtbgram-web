import type { ChangeEvent } from 'react';
import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { ApiBotCommand, ApiUser } from '../../../api/types';
import type { IconName } from '../../../types/icons';
import type { RegularLangKey } from '../../../types/language';

import { getMainUsername, getUserFullName } from '../../../global/helpers';
import buildClassName from '../../../util/buildClassName';
import { copyTextToClipboard } from '../../../util/clipboard';
import { isUsernameValid } from '../../../util/entities/username';
import { debounce } from '../../../util/schedulers';
import { callApi } from '../../../api/gramjs';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Avatar from '../../common/Avatar';
import Icon from '../../common/icons/Icon';
import SafeLink from '../../common/SafeLink';
import Button from '../../ui/Button';
import ConfirmDialog from '../../ui/ConfirmDialog';
import InputText from '../../ui/InputText';
import SearchInput from '../../ui/SearchInput';
import Spinner from '../../ui/Spinner';
import Switcher from '../../ui/Switcher';
import TextArea from '../../ui/TextArea';

import styles from './BotFatherModal.module.scss';

const LEARN_MORE_URL = 'https://core.telegram.org/bots';
const DEVELOPER_TERMS_URL = 'https://telegram.org/tos/bot-developers';
const COMMANDS_LEARN_MORE_URL = 'https://core.telegram.org/bots/features#commands';
const COMMANDS_API_URL = 'https://core.telegram.org/bots/api#setmycommands';
const COMMANDS_SCOPE_URL = 'https://core.telegram.org/bots/features#command-scopes';
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

type MiniAppsScreenProps = {
  bot: ApiUser;
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
          {botFather ? (
            <Avatar peer={botFather} size="jumbo" className={styles.heroAvatar} />
          ) : (
            <div className={buildClassName(styles.heroAvatar, styles.heroFallback)}>
              <Icon name="bots" className={styles.heroFallbackIcon} />
            </div>
          )}
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
  const [about, setAbout] = useState('');
  const [username, setUsername] = useState('');
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
      <button
        type="button"
        className={styles.photoButton}
        aria-label={lang('BotFatherSetPhoto')}
        onClick={handlePickPhoto}
      >
        {photoPreviewUrl ? (
          <img src={photoPreviewUrl} alt="" className={styles.photoPreview} />
        ) : (
          <Icon name="camera-add" className={styles.photoIcon} />
        )}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className={styles.hiddenInput}
        onChange={handlePhotoChange}
      />
      <h2 className={styles.pageTitle}>{lang('BotFatherCreateTitle')}</h2>
      <p className={styles.pageSubtitle}>{lang('BotFatherCreateSubtitle')}</p>

      <InputText
        className={styles.field}
        value={name}
        label={lang('BotFatherNameLabel')}
        disabled={isCreating}
        onChange={handleNameChange}
      />
      <TextArea
        className={styles.field}
        value={about}
        label={lang('BotFatherAboutLabel')}
        disabled={isCreating}
        onChange={handleAboutChange}
      />
      <div className={styles.usernameRow}>
        <span className={styles.usernamePrefix}>t.me/</span>
        <InputText
          className={styles.usernameInput}
          value={username}
          label={lang('BotFatherUsernameLabel')}
          placeholder={lang('BotFatherUsernamePlaceholder')}
          disabled={isCreating}
          onChange={handleUsernameChange}
        />
      </div>
      {isAvailableConfirmed && (
        <p className={styles.usernameAvailable}>
          {lang('UsernameAvailable', { username })}
        </p>
      )}
      {visibleUsernameErrorKey && (
        <p className={styles.usernameError}>
          {lang(visibleUsernameErrorKey)}
        </p>
      )}
      <p className={styles.hint}>{lang('BotFatherUsernameHint')}</p>
      {generalErrorKey && <p className={styles.error}>{lang(generalErrorKey)}</p>}
      <Button
        className={styles.submitButton}
        disabled={isCreating || !isAvailableConfirmed}
        onClick={handleCreate}
      >
        {isCreating ? <Spinner color="white" /> : lang('BotFatherCreateSubmit')}
      </Button>
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
    revokeBotFatherBotToken,
    deleteBotViaBotFather,
    runBotFatherManageCommand,
    showNotification,
  } = getActions();

  const lang = useLang();

  const [isTokenVisible, showToken, hideToken] = useFlag();
  const [isRevokeConfirmOpen, openRevokeConfirm, closeRevokeConfirm] = useFlag();
  const [isDeleteConfirmOpen, openDeleteConfirm, closeDeleteConfirm] = useFlag();

  const username = getMainUsername(bot);
  const isBusy = Boolean(isDeletingBot || isRunningManageCommand || isRevokingToken);

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

  const handleManageCommand = useLastCallback((command: string) => {
    if (isBusy) {
      showNotification({ message: { key: 'BotFatherBusy' } });
      return;
    }
    if (!username) return;
    runBotFatherManageCommand({ command });
  });

  const handleConfirmDelete = useLastCallback(() => {
    closeDeleteConfirm();
    deleteBotViaBotFather();
  });

  function renderNavRow(
    icon: IconName,
    label: string,
    onClick: NoneToVoidFunction,
    options?: { badge?: string; destructive?: boolean; withPrimaryColor?: boolean },
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
        {isBusy ? <Spinner className={styles.rowSpinner} /> : <Icon name="next" className={styles.rowChevron} />}
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
      return <span className={styles.tokenPlaceholder}>{lang('BotFatherTokenMissing')}</span>;
    }

    return (
      <>
        <span className={styles.tokenValue}>
          {isTokenVisible ? botToken : `${botToken.slice(0, TOKEN_VISIBLE_CHARS)}${TOKEN_MASK}`}
        </span>
        <Button
          round
          size="tiny"
          color="translucent"
          ariaLabel={lang(isTokenVisible ? 'BotFatherTokenHide' : 'BotFatherTokenShow')}
          onClick={handleToggleToken}
        >
          <Icon name={isTokenVisible ? 'eye-crossed' : 'eye'} />
        </Button>
      </>
    );
  }

  return (
    <div className={styles.screen}>
      <div className={buildClassName(styles.scrollBody, 'custom-scroll')}>
        <div className={styles.hero}>
          <Avatar peer={bot} size="jumbo" className={styles.heroAvatar} />
          <h2 className={styles.heroTitle}>{getUserFullName(bot)}</h2>
          {username && <p className={styles.heroUsername}>{`@${username}`}</p>}
        </div>

        <div className={styles.tokenCard}>
          <div className={styles.tokenRow}>
            <Icon name="key" className={styles.tokenIcon} />
            {renderToken()}
          </div>
          <div className={styles.tokenActions}>
            <Button size="smaller" disabled={!botToken} onClick={handleCopyToken}>
              {lang('BotFatherTokenCopy')}
            </Button>
            <Button
              size="smaller"
              color="danger"
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
          {renderNavRow('bots', lang('BotFatherBotSettings'), () => handleManageCommand('/setjoingroup'))}
          {renderNavRow('key', lang('BotFatherLoginWidget'), () => handleManageCommand('/setdomain'))}
          {renderNavRow('cloud-download', lang('BotFatherServerless'), () => handleManageCommand('/newapp'), {
            badge: lang('BotFatherNewBadge'),
          })}
          {renderNavRow('sport', lang('BotFatherGames'), () => handleManageCommand('/newgame'))}
        </div>

        <h3 className={styles.sectionTitle}>{lang('BotFatherMonetization')}</h3>
        <div className={styles.listGroup}>
          {renderNavRow('cash-circle', lang('BotFatherPayments'), () => handleManageCommand('/mybots'))}
          {renderNavRow('star', lang('BotFatherTelegramStars'), () => handleManageCommand('/mybots'))}
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

        <h3 className={styles.sectionTitle}>{lang('BotFatherActions')}</h3>
        <div className={styles.listGroup}>
          {renderNavRow('replace', lang('BotFatherTransfer'), () => handleManageCommand('/transferbot'), {
            withPrimaryColor: true,
          })}
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

const BotFatherMiniAppsScreen = ({ bot }: MiniAppsScreenProps) => {
  const { runBotFatherManageCommand } = getActions();

  const lang = useLang();
  const username = getMainUsername(bot);

  const handleMenuButton = useLastCallback(() => {
    if (!username) return;
    runBotFatherManageCommand({ command: '/setmenubutton' });
  });

  const handleMainApp = useLastCallback(() => {
    if (!username) return;
    runBotFatherManageCommand({ command: '/setmainapp' });
  });

  return (
    <div className={buildClassName(styles.scrollBody, 'custom-scroll')}>
      <p className={styles.pageSubtitle}>{lang('BotFatherMiniAppsIntro')}</p>
      <div className={styles.listGroup}>
        <button type="button" className={styles.navRow} onClick={handleMenuButton}>
          <Icon name="menu" className={styles.navIcon} />
          <span className={styles.navLabel}>{lang('BotFatherMenuButton')}</span>
          <Icon name="next" className={styles.rowChevron} />
        </button>
        <button type="button" className={styles.navRow} onClick={handleMainApp}>
          <Icon name="webapp" className={styles.navIcon} />
          <span className={styles.navLabel}>{lang('BotFatherMainApp')}</span>
          <Icon name="next" className={styles.rowChevron} />
        </button>
      </div>
      <p className={styles.groupHint}>{lang('BotFatherManageCommandSent')}</p>
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
