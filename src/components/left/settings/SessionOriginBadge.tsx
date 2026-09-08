import { memo } from '../../../lib/teact/teact';

import type { ApiSession } from '../../../api/types';

import buildClassName from '../../../util/buildClassName';
import getSessionOrigin, { getSessionInternalClient } from './helpers/getSessionOrigin';

import useLang from '../../../hooks/useLang';

import styles from './SessionOriginBadge.module.scss';

type OwnProps = {
  session: ApiSession;
  className?: string;
};

const SessionOriginBadge = ({ session, className }: OwnProps) => {
  const lang = useLang();

  if (getSessionOrigin(session) === 'thirdParty') {
    return undefined;
  }

  const internalClient = getSessionInternalClient(session);

  return (
    <span className={buildClassName(styles.root, internalClient && styles.internal, className)}>
      {internalClient
        ? lang('SessionOriginInternalClient', { client: internalClient })
        : lang('SessionOriginOfficial')}
    </span>
  );
};

export default memo(SessionOriginBadge);
