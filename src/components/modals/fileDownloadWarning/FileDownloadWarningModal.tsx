import { memo } from '../../../lib/teact/teact';
import { getActions, getGlobal } from '../../../global';

import type { TabState } from '../../../global/types';

import { selectChatMessage } from '../../../global/selectors';
import { selectMessageDownloadableMedia } from '../../../global/selectors/media';

import useLastCallback from '../../../hooks/useLastCallback';

import FileDownloadWarningDialog from '../../common/FileDownloadWarningModal';

type OwnProps = {
  modal: TabState['fileDownloadWarningModal'];
};

const FileDownloadWarningModal = ({ modal }: OwnProps) => {
  const {
    closeFileDownloadWarningModal,
    downloadMedia,
  } = getActions();

  const handleClose = useLastCallback(() => {
    closeFileDownloadWarningModal();
  });

  const handleConfirm = useLastCallback(() => {
    if (!modal) return;

    const global = getGlobal();
    const message = selectChatMessage(global, modal.chatId, modal.messageId);
    const media = message && selectMessageDownloadableMedia(global, message);

    handleClose();

    if (!message || !media) return;
    downloadMedia({
      media,
      originMessage: message,
      shouldSkipWarning: true,
    });
  });

  return (
    <FileDownloadWarningDialog
      isOpen={Boolean(modal)}
      onClose={handleClose}
      onConfirm={handleConfirm}
    />
  );
};

export default memo(FileDownloadWarningModal);
