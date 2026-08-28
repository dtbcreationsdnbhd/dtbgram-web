import type { TeactNode } from '../../../lib/teact/teact';
import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getActions, getGlobal, withGlobal } from '../../../global';

import type { ApiPeer } from '../../../api/types';
import { ApiMessageEntityTypes } from '../../../api/types';

import { fetchChatByUsername } from '../../../global/actions/api/chats';
import { getPeerFullTitle } from '../../../global/helpers/peers';
import { selectPeer } from '../../../global/selectors';

import useAppLayout from '../../../hooks/useAppLayout';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

type OwnProps = {
  userId?: string;
  username?: string;
  children: TeactNode;
};

type StateProps = {
  userOrChat?: ApiPeer;
};

const resolvedUsernamePeerIds = new Map<string, string>();

function normalizeUsername(username?: string) {
  if (!username) {
    return undefined;
  }

  return username.startsWith('@') ? username.slice(1).toLowerCase() : username.toLowerCase();
}

function getCachedPeer(username: string) {
  const cachedPeerId = resolvedUsernamePeerIds.get(username);
  if (!cachedPeerId) {
    return undefined;
  }

  return selectPeer(getGlobal(), cachedPeerId);
}

const MentionLink = ({
  userId,
  username,
  userOrChat,
  children,
}: OwnProps & StateProps) => {
  const {
    openChat,
    openChatByUsername,
    closeStoryViewer,
    setShouldCloseRightColumn,
  } = getActions();

  const lang = useLang();
  const { isMobile } = useAppLayout();
  const normalizedUsername = normalizeUsername(username);
  const [resolvedPeer, setResolvedPeer] = useState<ApiPeer | undefined>(
    () => (normalizedUsername ? getCachedPeer(normalizedUsername) : undefined),
  );
  const [hasResolveFailed, setHasResolveFailed] = useState(false);
  const peer = userOrChat || resolvedPeer || (normalizedUsername ? getCachedPeer(normalizedUsername) : undefined);
  const displayName = peer ? getPeerFullTitle(lang, peer) : undefined;
  const isResolvingUsername = Boolean(normalizedUsername && !userId && !peer && !hasResolveFailed);

  const resolveUsername = useLastCallback(async (usernameToResolve: string) => {
    const cachedPeer = getCachedPeer(usernameToResolve);
    if (cachedPeer) {
      setResolvedPeer(cachedPeer);
      return;
    }

    const chat = await fetchChatByUsername(getGlobal(), usernameToResolve);
    if (!chat) {
      setHasResolveFailed(true);
      return;
    }

    const peerFromStore = selectPeer(getGlobal(), chat.id);
    if (!peerFromStore) {
      setHasResolveFailed(true);
      return;
    }

    resolvedUsernamePeerIds.set(usernameToResolve, chat.id);
    setResolvedPeer(peerFromStore);
  });

  useEffect(() => {
    setHasResolveFailed(false);

    if (userId || peer || !normalizedUsername) {
      return;
    }

    void resolveUsername(normalizedUsername);
  }, [normalizedUsername, peer, resolveUsername, userId]);

  const handleClick = useLastCallback(() => {
    if (isMobile) {
      setShouldCloseRightColumn({
        value: true,
      });
    }

    if (peer) {
      openChat({ id: peer.id });
      return;
    }

    if (normalizedUsername) {
      closeStoryViewer();
      openChatByUsername({ username: normalizedUsername });
    }
  });

  if (isResolvingUsername) {
    return undefined;
  }

  return (
    <a
      onClick={handleClick}
      className="text-entity-link"
      dir="auto"
      data-entity-type={userId || peer ? ApiMessageEntityTypes.MentionName : ApiMessageEntityTypes.Mention}
    >
      {displayName ? `@${displayName}` : children}
    </a>
  );
};

export default memo(withGlobal<OwnProps>(
  (global, { userId }): Complete<StateProps> => {
    return {
      userOrChat: userId ? selectPeer(global, userId) : undefined,
    };
  },
)(MentionLink));
