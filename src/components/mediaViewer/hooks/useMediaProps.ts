import { useEffect, useMemo } from '../../../lib/teact/teact';

import type { MediaViewerMedia } from '../../../types';
import { ApiMediaFormat } from '../../../api/types';
import { MediaViewerOrigin } from '../../../types';

import {
  getMediaFileSize,
  getMediaFormat,
  getMediaHash,
  getMediaSearchType,
  getMediaThumbUri,
  getPhotoFullDimensions,
  getProfilePhotoMediaHash,
  getVideoDimensions,
  getVideoProfilePhotoMediaHash,
  isDocumentPhoto,
  isDocumentVideo,
} from '../../../global/helpers';
import { AVATAR_FULL_DIMENSIONS, VIDEO_AVATAR_FULL_DIMENSIONS } from '../../common/helpers/mediaDimensions';

import useBlurSync from '../../../hooks/useBlurSync';
import useFlag from '../../../hooks/useFlag';
import useMedia from '../../../hooks/useMedia';
import useMediaWithLoadProgress from '../../../hooks/useMediaWithLoadProgress';

const FALLBACK_DIMENSIONS = AVATAR_FULL_DIMENSIONS;

type UseMediaProps = {
  media?: MediaViewerMedia;
  isAvatar?: boolean;
  origin?: MediaViewerOrigin;
  delay: number | false;
  overrideUrl?: string;
};

export const useMediaProps = ({
  media,
  isAvatar,
  origin,
  delay,
  overrideUrl,
}: UseMediaProps) => {
  const isPhotoAvatar = !overrideUrl && isAvatar && media?.mediaType === 'photo' && !media.isVideo;
  const isVideoAvatar = !overrideUrl && isAvatar && media?.mediaType === 'photo' && media.isVideo;
  const isDocument = !overrideUrl && media?.mediaType === 'document';
  const isVideo = !overrideUrl && (
    (media?.mediaType === 'video' && !media.isRound) || (isDocument && isDocumentVideo(media))
  );
  const isPhoto = Boolean(overrideUrl) || media?.mediaType === 'photo' || (isDocument && isDocumentPhoto(media));
  const isGif = !overrideUrl && media?.mediaType === 'video' && media.isGif;
  const isFromSharedMedia = origin === MediaViewerOrigin.SharedMedia;
  const isFromSearch = origin === MediaViewerOrigin.SearchResult;

  const [shouldForceBlob, markForceBlob, unmarkForceBlob] = useFlag();

  useEffect(() => {
    unmarkForceBlob();
  }, [media?.id]);

  const contentType = media && getMediaSearchType(media);
  const fullMediaFormat = media && (
    shouldForceBlob ? ApiMediaFormat.BlobUrl : getMediaFormat(media, 'full')
  );

  const getMediaOrAvatarHash = useMemo(() => (isFull?: boolean) => {
    if (overrideUrl || !media) return undefined;

    if ((isPhotoAvatar || isVideoAvatar) && !isFull) {
      return getProfilePhotoMediaHash(media);
    }

    if (isVideoAvatar && isFull) {
      return getVideoProfilePhotoMediaHash(media);
    }

    return getMediaHash(media, isFull ? 'full' : 'preview');
  }, [isPhotoAvatar, isVideoAvatar, media, overrideUrl]);

  const pictogramBlobUrl = useMedia(
    !overrideUrl
    && media
    // Only use pictogram if it's already loaded
    && (isFromSharedMedia || isFromSearch || isDocument)
    && getMediaHash(media, 'pictogram'),
    undefined,
    ApiMediaFormat.BlobUrl,
    delay,
  );
  const previewMediaHash = getMediaOrAvatarHash();
  const previewBlobUrl = useMedia(
    previewMediaHash,
    undefined,
    ApiMediaFormat.BlobUrl,
    delay,
  );
  const {
    mediaData: fullMediaBlobUrl,
    loadProgress,
  } = useMediaWithLoadProgress(
    getMediaOrAvatarHash(true),
    undefined,
    fullMediaFormat,
    delay,
  );

  const localBlobUrl = overrideUrl || (media && 'blobUrl' in media ? media.blobUrl : undefined);
  let bestImageData = (!isVideo && (localBlobUrl || fullMediaBlobUrl)) || previewBlobUrl || pictogramBlobUrl;
  const thumbDataUri = useBlurSync(!overrideUrl && !bestImageData && media && getMediaThumbUri(media));
  if (!overrideUrl && !bestImageData && origin !== MediaViewerOrigin.SearchResult) {
    bestImageData = thumbDataUri;
  }
  if (isVideoAvatar && previewBlobUrl) {
    bestImageData = previewBlobUrl;
  }
  const bestData = overrideUrl || localBlobUrl || fullMediaBlobUrl || (
    (!isVideoAvatar && !isVideo) ? (previewBlobUrl || pictogramBlobUrl || bestImageData) : undefined
  );

  const mediaSize = media && getMediaFileSize(media);

  const dimensions = useMemo(() => {
    if (isAvatar) {
      return isVideoAvatar ? VIDEO_AVATAR_FULL_DIMENSIONS : AVATAR_FULL_DIMENSIONS;
    }

    if (isDocument) {
      return media.mediaSize || FALLBACK_DIMENSIONS;
    }

    if (isPhoto && media) {
      return 'sizes' in media ? getPhotoFullDimensions(media) : FALLBACK_DIMENSIONS;
    }

    if (isVideo && media) {
      return 'duration' in media ? getVideoDimensions(media) : FALLBACK_DIMENSIONS;
    }

    return FALLBACK_DIMENSIONS;
  }, [isAvatar, isDocument, isPhoto, isVideo, isVideoAvatar, media]);

  return {
    getMediaHash: getMediaOrAvatarHash,
    media,
    isVideo,
    isPhoto,
    isGif,
    isDocument,
    bestImageData,
    bestData,
    dimensions,
    contentType,
    isVideoAvatar,
    loadProgress,
    mediaSize,
    retryAsBlob: shouldForceBlob ? undefined : markForceBlob,
  };
};
