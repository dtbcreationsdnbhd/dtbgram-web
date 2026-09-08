import { memo, useMemo, useState } from '../../../lib/teact/teact';
import { withGlobal } from '../../../global';

import type { ApiSession } from '../../../api/types';
import type { RegularLangKey } from '../../../types/language';

import { formatPastTimeShort } from '../../../util/dates/oldDateFormat';
import getSessionIcon, { DEVICE_BACKDROP } from './helpers/getSessionIcon';
import getSessionLocation from './helpers/getSessionLocation';
import getSessionOrigin, { stripSessionPlatformLabel } from './helpers/getSessionOrigin';

import useFlag from '../../../hooks/useFlag';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useOldLang from '../../../hooks/useOldLang';

import Island, { IslandTitle } from '../../gili/layout/Island';
import ListItem from '../../ui/ListItem';
import SessionOriginBadge from './SessionOriginBadge';
import SettingsActiveSession from './SettingsActiveSession';

import styles from './SettingsDevicesOverview.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = {
  byHash: Record<string, ApiSession>;
  orderedHashes: string[];
};

const SettingsDevicesOverview = ({
  isActive,
  onReset,
  byHash,
  orderedHashes,
}: OwnProps & StateProps) => {
  const lang = useLang();
  const oldLang = useOldLang();

  const [openedSessionHash, setOpenedSessionHash] = useState<string | undefined>();
  const [isModalOpen, openModal, closeModal] = useFlag();

  const { internalHashes, externalHashes } = useMemo(() => {
    const internal: string[] = [];
    const external: string[] = [];

    orderedHashes.forEach((hash) => {
      const group = getSessionOrigin(byHash[hash]) === 'internal' ? internal : external;
      group.push(hash);
    });

    return { internalHashes: internal, externalHashes: external };
  }, [byHash, orderedHashes]);

  const handleOpenSession = useLastCallback((hash: string) => {
    setOpenedSessionHash(hash);
    openModal();
  });

  const handleCloseSession = useLastCallback(() => {
    setOpenedSessionHash(undefined);
    closeModal();
  });

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  function renderGroup(titleKey: RegularLangKey, sessionHashes: string[]) {
    return (
      <>
        <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>
          {lang(titleKey)}
          <span className={styles.count}>{lang.number(sessionHashes.length)}</span>
        </IslandTitle>
        <Island>
          {sessionHashes.length
            ? sessionHashes.map(renderSession)
            : <p className={styles.empty}>{lang('DevicesOverviewEmpty')}</p>}
        </Island>
      </>
    );
  }

  function renderSession(hash: string) {
    const session = byHash[hash];
    const { icon, color } = DEVICE_BACKDROP[getSessionIcon(session)];

    return (
      <ListItem
        key={hash}
        ripple
        narrow
        icon={icon}
        iconBg={color}
        onClick={() => { handleOpenSession(hash); }}
      >
        <div className="multiline-item full-size" dir="auto">
          <span className="title title-with-date">
            {session.deviceModel}
            <span className="date">
              {session.isCurrent
                ? lang('AuthSessionsCurrentSession')
                : formatPastTimeShort(oldLang, session.dateActive * 1000)}
            </span>
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
    <div className="settings-content custom-scroll">
      {renderGroup('SessionsFilterInternal', internalHashes)}
      {renderGroup('SessionsFilterExternal', externalHashes)}
      <SettingsActiveSession isOpen={isModalOpen} hash={openedSessionHash} onClose={handleCloseSession} />
    </div>
  );
};

export default memo(withGlobal<OwnProps>((global): Complete<StateProps> => {
  const { byHash, orderedHashes } = global.activeSessions;

  return { byHash, orderedHashes };
})(SettingsDevicesOverview));
