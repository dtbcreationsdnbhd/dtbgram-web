import { memo } from '../../lib/teact/teact';

import useLang from '../../hooks/useLang';

import ConfirmDialog from '../ui/ConfirmDialog';

type OwnProps = {
  isOpen: boolean;
  onClose: NoneToVoidFunction;
  onConfirm: NoneToVoidFunction;
};

const FileDownloadWarningModal = ({
  isOpen,
  onClose,
  onConfirm,
}: OwnProps) => {
  const lang = useLang();

  return (
    <ConfirmDialog
      isOpen={isOpen}
      title={lang('FileDownloadWarningTitle')}
      confirmLabel={lang('FileDownloadWarningConfirm')}
      onClose={onClose}
      confirmHandler={onConfirm}
    >
      {lang('FileDownloadWarningText')}
    </ConfirmDialog>
  );
};

export default memo(FileDownloadWarningModal);
