import { memo } from '../../../lib/teact/teact';

import type { ApiSession } from '../../../api/types';

import buildClassName from '../../../util/buildClassName';
import getSessionOrigin from './helpers/getSessionOrigin';

import useLang from '../../../hooks/useLang';

import styles from './SessionOriginBadge.module.scss';

type OwnProps = {
  session: ApiSession;
  className?: string;
};

const SessionOriginBadge = ({ session, className }: OwnProps) => {
  const lang = useLang();

  const origin = getSessionOrigin(session);
  if (origin === 'thirdParty') {
    return undefined;
  }

  const isInternal = origin === 'internal';

  return (
    <span className={buildClassName(styles.root, isInternal && styles.internal, className)}>
      {lang(isInternal ? 'SessionOriginInternal' : 'SessionOriginOfficial')}
    </span>
  );
};

export default memo(SessionOriginBadge);
