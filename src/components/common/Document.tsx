import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../lib/teact/teact';
import { getActions } from '../../global';

import type { ApiDocument, ApiMessage, MediaContent } from '../../api/types';
import type { ObserveFn } from '../../hooks/useIntersectionObserver';
import type { MenuItemContextAction } from '../ui/ListItem';

import {
  getDocumentMediaHash,
  getMediaFormat,
  getMediaTransferState,
  isDocumentVideo,
} from '../../global/helpers';
import { getDocumentExtension, getDocumentHasPreview } from './helpers/documentInfo';
import { preloadDocumentMedia } from './helpers/preloadDocumentMedia';

import useFlag from '../../hooks/useFlag';
import { useIsIntersecting } from '../../hooks/useIntersectionObserver';
import useLastCallback from '../../hooks/useLastCallback';
import useMediaWithLoadProgress from '../../hooks/useMediaWithLoadProgress';

import File from './File';
import FileDownloadWarningModal from './FileDownloadWarningModal';

type OwnProps = {
  document: ApiDocument;
  observeIntersection?: ObserveFn;
  fileSize?: 'small' | 'medium' | 'large';
  isSelected?: boolean;
  isSelectable?: boolean;
  canAutoLoad?: boolean;
  uploadProgress?: number;
  datetime?: number;
  className?: string;
  sender?: string;
  autoLoadFileMaxSizeMb?: number;
  isDownloading?: boolean;
  shouldWarnAboutFiles?: boolean;
  id?: string;
  onCancelUpload?: NoneToVoidFunction;
  contextActions?: MenuItemContextAction[];
} & ({
  message: ApiMessage;
  onDateClick: (arg: ApiMessage) => void;
  onMediaClick?: (messageId: number) => void;
} | {
  message?: ApiMessage;
  onDateClick?: never;
  onMediaClick?: NoneToVoidFunction;
});

const BYTES_PER_MB = 1024 * 1024;

const Document = ({
  document,
  observeIntersection,
  fileSize,
  canAutoLoad,
  autoLoadFileMaxSizeMb,
  uploadProgress,
  datetime,
  className,
  sender,
  isSelected,
  isSelectable,
  shouldWarnAboutFiles,
  isDownloading,
  message,
  id,
  onCancelUpload,
  onMediaClick,
  onDateClick,
  contextActions,
}: OwnProps) => {
  const { cancelMediaDownload, downloadMedia } = getActions();

  const ref = useRef<HTMLDivElement>();

  const [isFileWarningOpen, openFileWarning, closeFileWarning] = useFlag();

  const { fileName, size } = document;
  const extension = getDocumentExtension(document) || '';

  const isIntersecting = useIsIntersecting(ref, observeIntersection);
  const [wasIntersected, markIntersected] = useFlag();
  useEffect(() => {
    if (isIntersecting) {
      markIntersected();
    }
  }, [isIntersecting, markIntersected]);

  // Auto-loading does not use global download manager because requires additional click to save files locally
  const [isLoadAllowed, setIsLoadAllowed] = useState(
    canAutoLoad && (!autoLoadFileMaxSizeMb || size <= autoLoadFileMaxSizeMb * BYTES_PER_MB),
  );

  const shouldDownload = Boolean(isDownloading || (isLoadAllowed && wasIntersected));

  const documentHash = getDocumentMediaHash(document, 'download');
  const { loadProgress: downloadProgress, mediaData } = useMediaWithLoadProgress(
    documentHash, !shouldDownload, getMediaFormat(document, 'download'), undefined, true,
  );
  const isLoaded = Boolean(mediaData);

  const {
    isUploading, isTransferring, transferProgress,
  } = getMediaTransferState(
    uploadProgress || downloadProgress,
    shouldDownload && !isLoaded,
    uploadProgress !== undefined,
  );

  const hasPreview = getDocumentHasPreview(document);
  const previewMedia = useMemo<MediaContent | undefined>(
    () => (hasPreview ? { document } : undefined),
    [document, hasPreview],
  );

  const shouldForceDownload = document.innerMediaType === 'photo' && document.mediaSize
    && !document.mediaSize.fromDocumentAttribute && !document.mediaSize.fromPreload;

  const withMediaViewer = onMediaClick && document.innerMediaType && !shouldForceDownload;

  useEffect(() => {
    const fileEl = ref.current;
    if (!withMediaViewer || !fileEl || !message) return;

    const onHover = () => {
      preloadDocumentMedia(message);
    };

    fileEl.addEventListener('mouseenter', onHover);

    return () => {
      fileEl.removeEventListener('mouseenter', onHover);
    };
  }, [withMediaViewer, message]);

  const handleDownload = useLastCallback((shouldSkipWarning?: boolean) => {
    downloadMedia({ media: document, originMessage: message, shouldSkipWarning });
  });

  const handleClick = useLastCallback(() => {
    if (isUploading) {
      if (onCancelUpload) {
        onCancelUpload();
      }
      return;
    }

    if (isDownloading) {
      cancelMediaDownload({ media: document });
      return;
    }

    if (isTransferring) {
      setIsLoadAllowed(false);
      return;
    }

    if (withMediaViewer) {
      if (message) {
        onMediaClick?.(message.id);
      } else if (onMediaClick) {
        (onMediaClick as NoneToVoidFunction)();
      }
      return;
    }

    if (shouldWarnAboutFiles) {
      openFileWarning();
      return;
    }

    handleDownload();
  });

  const handleFileWarningConfirm = useLastCallback(() => {
    closeFileWarning();
    handleDownload(true);
  });

  const handleDateClick = useLastCallback(() => {
    onDateClick?.(message);
  });

  return (
    <>
      <File
        ref={ref}
        id={id}
        name={fileName}
        extension={extension}
        size={size}
        timestamp={datetime}
        previewMedia={previewMedia}
        observeIntersection={observeIntersection}
        previewSize={fileSize}
        isTransferring={isTransferring}
        isUploading={isUploading}
        transferProgress={transferProgress}
        className={className}
        sender={sender}
        isSelectable={isSelectable}
        isSelected={isSelected}
        actionIcon={withMediaViewer ? (isDocumentVideo(document) ? 'play' : 'eye') : 'download'}
        contextActions={contextActions}
        onClick={handleClick}
        onDateClick={onDateClick ? handleDateClick : undefined}
      />
      <FileDownloadWarningModal
        isOpen={isFileWarningOpen}
        onClose={closeFileWarning}
        onConfirm={handleFileWarningConfirm}
      />
    </>
  );
};

export default memo(Document);
