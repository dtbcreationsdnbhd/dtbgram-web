import type { FC } from '../../../lib/teact/teact';
import {
  memo, useCallback, useMemo, useState,
} from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiSession } from '../../../api/types';
import type { GlobalState } from '../../../global/types';

import { formatPastTimeShort } from '../../../util/dates/oldDateFormat';
import getSessionIcon, { DEVICE_BACKDROP } from './helpers/getSessionIcon';
import getSessionLocation from './helpers/getSessionLocation';
import getSessionOrigin, { stripSessionPlatformLabel } from './helpers/getSessionOrigin';

import useFlag from '../../../hooks/useFlag';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useOldLang from '../../../hooks/useOldLang';

import Island, { IslandTitle } from '../../gili/layout/Island';
import ConfirmDialog from '../../ui/ConfirmDialog';
import ListItem from '../../ui/ListItem';
import RadioGroup from '../../ui/RadioGroup';
import SquareTabList, { type TabWithProperties } from '../../ui/SquareTabList';
import SessionOriginBadge from './SessionOriginBadge';
import SettingsActiveSession from './SettingsActiveSession';

import './SettingsActiveSessions.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = GlobalState['activeSessions'];

const SESSION_FILTERS = ['all', 'internal', 'external'] as const;
const SESSION_FILTER_KEYS = ['SessionsFilterAll', 'SessionsFilterInternal', 'SessionsFilterExternal'] as const;

const SettingsActiveSessions: FC<OwnProps & StateProps> = ({
  isActive,
  onReset,
  byHash,
  orderedHashes,
  ttlDays,
}) => {
  const {
    terminateAuthorization,
    terminateAllAuthorizations,
    changeSessionTtl,
  } = getActions();

  const oldLang = useOldLang();
  const lang = useLang();
  const [isConfirmTerminateAllDialogOpen, openConfirmTerminateAllDialog, closeConfirmTerminateAllDialog] = useFlag();
  const [openedSessionHash, setOpenedSessionHash] = useState<string | undefined>();
  const [isModalOpen, openModal, closeModal] = useFlag();
  const [activeFilterIndex, setActiveFilterIndex] = useState(0);

  const autoTerminateValue = useMemo(() => {
    // https://github.com/DrKLO/Telegram/blob/96dce2c9aabc33b87db61d830aa087b6b03fe397/TMessagesProj/src/main/java/org/telegram/ui/SessionsActivity.java#L195
    if (ttlDays === undefined) {
      return undefined;
    }

    if (ttlDays <= 7) {
      return '7';
    }

    if (ttlDays <= 30) {
      return '30';
    }

    if (ttlDays <= 93) {
      return '90';
    }

    if (ttlDays <= 183) {
      return '183';
    }

    if (ttlDays > 183) {
      return '365';
    }

    return undefined;
  }, [ttlDays]);

  const AUTO_TERMINATE_OPTIONS = useMemo(() => {
    const options = [{
      label: lang('Weeks', { count: 1 }, { pluralValue: 1 }),
      value: '7',
    }, {
      label: lang('Months', { count: 1 }, { pluralValue: 1 }),
      value: '30',
    }, {
      label: lang('Months', { count: 3 }, { pluralValue: 3 }),
      value: '90',
    }, {
      label: lang('Months', { count: 6 }, { pluralValue: 6 }),
      value: '183',
    }];
    if (ttlDays && ttlDays >= 365) {
      options.push({
        label: lang('Years', { count: 1 }, { pluralValue: 1 }),
        value: '365',
      });
    }
    return options;
  }, [lang, ttlDays]);

  const handleTerminateSessionClick = useCallback((hash: string) => {
    terminateAuthorization({ hash });
  }, [terminateAuthorization]);

  const handleTerminateAllSessions = useCallback(() => {
    closeConfirmTerminateAllDialog();
    terminateAllAuthorizations();
  }, [closeConfirmTerminateAllDialog, terminateAllAuthorizations]);

  const handleOpenSessionModal = useCallback((hash: string) => {
    setOpenedSessionHash(hash);
    openModal();
  }, [openModal]);

  const handleCloseSessionModal = useCallback(() => {
    setOpenedSessionHash(undefined);
    closeModal();
  }, [closeModal]);

  const handleChangeSessionTtl = useCallback((value: string) => {
    changeSessionTtl({ days: Number(value) });
  }, [changeSessionTtl]);

  const currentSession = useMemo(() => {
    const currentSessionHash = orderedHashes.find((hash) => byHash[hash].isCurrent);

    return currentSessionHash ? byHash[currentSessionHash] : undefined;
  }, [byHash, orderedHashes]);

  const otherSessionHashes = useMemo(() => {
    return orderedHashes.filter((hash) => !byHash[hash].isCurrent);
  }, [byHash, orderedHashes]);
  const hasOtherSessions = Boolean(otherSessionHashes.length);

  const filterTabs = useMemo<TabWithProperties[]>(() => {
    return SESSION_FILTER_KEYS.map((key) => ({ title: lang(key) }));
  }, [lang]);

  const filteredSessionHashes = useMemo(() => {
    const activeFilter = SESSION_FILTERS[activeFilterIndex];
    if (activeFilter === 'all') {
      return otherSessionHashes;
    }

    const shouldBeInternal = activeFilter === 'internal';

    return otherSessionHashes.filter((hash) => {
      return (getSessionOrigin(byHash[hash]) === 'internal') === shouldBeInternal;
    });
  }, [activeFilterIndex, byHash, otherSessionHashes]);

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  function renderCurrentSession(session: ApiSession) {
    const { icon, color } = DEVICE_BACKDROP[getSessionIcon(session)];

    return (
      <>
        <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>
          {lang('AuthSessionsCurrentSession')}
        </IslandTitle>
        <Island>
          <ListItem
            narrow
            inactive
            icon={icon}
            iconBg={color}
          >
            <div className="multiline-item full-size" dir="auto">
              <span className="title" dir="auto">{session.deviceModel}</span>
              <span className="subtitle black tight">
                {session.appName}
                {' '}
                {stripSessionPlatformLabel(session.appVersion)}
                ,
                {' '}
                {session.platform}
                {' '}
                {session.systemVersion}
                <SessionOriginBadge session={session} />
              </span>
              <span className="subtitle">
                {session.ip}
                {' '}
                -
                {' '}
                {getSessionLocation(session)}
              </span>
            </div>
          </ListItem>

          {hasOtherSessions && (
            <ListItem
              className="destructive mb-0 no-icon"
              icon="stop"
              ripple
              narrow
              onClick={openConfirmTerminateAllDialog}
            >
              {lang('TerminateAllSessions')}
            </ListItem>
          )}
        </Island>
      </>
    );
  }

  function renderOtherSessions(sessionHashes: string[]) {
    return (
      <>
        <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>
          {lang('OtherSessions')}
        </IslandTitle>
        <SquareTabList
          className="session-filter-tabs"
          tabs={filterTabs}
          activeTab={activeFilterIndex}
          onSwitchTab={setActiveFilterIndex}
        />
        <Island>
          {sessionHashes.length
            ? sessionHashes.map(renderSession)
            : <p className="session-filter-empty">{lang('SessionsFilterEmpty')}</p>}
        </Island>
      </>
    );
  }

  function renderAutoTerminate() {
    return (
      <>
        <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>
          {lang('TerminateOldSessionHeader')}
        </IslandTitle>
        <Island>
          <p className="settings-item-description-larger">{lang('IfInactiveFor')}</p>
          <RadioGroup
            name="session_ttl"
            options={AUTO_TERMINATE_OPTIONS}
            selected={autoTerminateValue}
            onChange={handleChangeSessionTtl}
          />
        </Island>
      </>
    );
  }

  function renderSession(sessionHash: string) {
    const session = byHash[sessionHash];
    const { icon, color } = DEVICE_BACKDROP[getSessionIcon(session)];

    return (
      <ListItem
        key={session.hash}
        ripple
        narrow
        contextActions={[{
          title: lang('SessionTerminate'),
          icon: 'stop',
          destructive: true,
          handler: () => {
            handleTerminateSessionClick(session.hash);
          },
        }]}
        icon={icon}
        iconBg={color}
        onClick={() => { handleOpenSessionModal(session.hash); }}
      >
        <div className="multiline-item full-size" dir="auto">
          <span className="title title-with-date">
            {session.deviceModel}
            <span className="date">{formatPastTimeShort(oldLang, session.dateActive * 1000)}</span>
          </span>
          <span className="subtitle black tight">
            {session.appName}
            {' '}
            {stripSessionPlatformLabel(session.appVersion)}
            ,
            {' '}
            {session.platform}
            {' '}
            {session.systemVersion}
            <SessionOriginBadge session={session} />
          </span>
          <span className="subtitle">
            {session.ip}
            {' '}
            {getSessionLocation(session)}
          </span>
        </div>
      </ListItem>
    );
  }

  return (
    <div className="settings-content custom-scroll SettingsActiveSessions">
      {currentSession && renderCurrentSession(currentSession)}
      {hasOtherSessions && renderOtherSessions(filteredSessionHashes)}
      {renderAutoTerminate()}
      {hasOtherSessions && (
        <ConfirmDialog
          isOpen={isConfirmTerminateAllDialogOpen}
          onClose={closeConfirmTerminateAllDialog}
          text={lang('AreYouSureSessions')}
          confirmLabel={lang('TerminateAllSessions')}
          confirmHandler={handleTerminateAllSessions}
          confirmIsDestructive
          areButtonsInColumn
        />
      )}
      <SettingsActiveSession isOpen={isModalOpen} hash={openedSessionHash} onClose={handleCloseSessionModal} />
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => global.activeSessions as Complete<StateProps>,
)(SettingsActiveSessions));
