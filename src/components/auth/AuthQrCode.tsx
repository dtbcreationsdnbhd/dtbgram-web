import {
  memo, useEffect, useLayoutEffect, useRef, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';

import { STRICTERDOM_ENABLED } from '../../config';
import { disableStrict, enableStrict } from '../../lib/fasterdom/stricterdom';
import { selectSharedSettings } from '../../global/selectors/sharedState';
import buildClassName from '../../util/buildClassName';
import { publishOfficialLoginQr } from '../../util/internalQrAuth';
import { oldSetLanguage } from '../../util/oldLangProvider';
import { createStyledQrCode } from '../../util/qrCode/buildStyledQrCode';
import { navigateBack } from './helpers/backNavigation';
import { getSuggestedLanguage } from './helpers/getSuggestedLanguage';

import useAsync from '../../hooks/useAsync';
import useFlag from '../../hooks/useFlag';
import useLang from '../../hooks/useLang';
import useLangString from '../../hooks/useLangString';
import useLastCallback from '../../hooks/useLastCallback';
import useMediaTransitionDeprecated from '../../hooks/useMediaTransitionDeprecated';
import useMultiaccountInfo from '../../hooks/useMultiaccountInfo';

import Button from '../ui/Button';
import Loading from '../ui/Loading';

import justChatLogoPath from '../../assets/just-chat-logo.png';

type StateProps = {
  auth: GlobalState['auth'];
  connectionState: GlobalState['connectionState'];
  language?: string;
};

const QR_SIZE = 280;
const QR_PLANE_SIZE = 54;
const QR_IMAGE_SIZE_RATIO = 0.4;
const QR_CODE_MUTATION_DURATION = 50; // The library is asynchronous and we need to wait for its mutation code

const AuthCode = ({
  connectionState,
  auth,
  language,
}: StateProps) => {
  const {
    returnToAuthPhoneNumber,
    setSharedSettingOption,
    loginWithPasskey,
  } = getActions();

  const { state, qrCode: authQrCode, passkeyOption } = auth;

  const suggestedLanguage = getSuggestedLanguage();
  const lang = useLang();
  const qrCodeRef = useRef<HTMLDivElement>();

  const isConnected = connectionState === 'connectionStateReady';
  const continueText = useLangString('AuthContinueOnThisLanguage', suggestedLanguage);
  const [isLoading, markIsLoading, unmarkIsLoading] = useFlag();
  const [isQrMounted, markQrMounted, unmarkQrMounted] = useFlag();
  const [internalQrPayload, setInternalQrPayload] = useState<string>();
  const [hasInternalQrFailed, setHasInternalQrFailed] = useState(false);

  const accountsInfo = useMultiaccountInfo();
  const hasActiveAccount = Object.values(accountsInfo).length > 0;

  const { result: qrCode } = useAsync(() => createStyledQrCode({
    size: QR_SIZE,
    imageSize: QR_IMAGE_SIZE_RATIO,
  }), []);

  const transitionClassNames = useMediaTransitionDeprecated(isQrMounted);

  useEffect(() => {
    if (!authQrCode?.token || !isConnected) {
      setInternalQrPayload(undefined);
      setHasInternalQrFailed(false);
      return undefined;
    }

    let isCancelled = false;

    const registerInternalQr = async () => {
      setHasInternalQrFailed(false);
      const challenge = await publishOfficialLoginQr(authQrCode.token);
      if (isCancelled) {
        return;
      }

      if (!challenge?.internalQrPayload) {
        setInternalQrPayload(undefined);
        setHasInternalQrFailed(true);
        return;
      }

      setInternalQrPayload(challenge.internalQrPayload);
      setHasInternalQrFailed(false);
    };

    void registerInternalQr();

    return () => {
      isCancelled = true;
    };
  }, [authQrCode, isConnected]);

  useLayoutEffect(() => {
    // Never fall back to the official Telegram QR (`tg://login?token=...`).
    if (!authQrCode || !qrCode || !internalQrPayload) {
      return () => {
        unmarkQrMounted();
      };
    }

    if (!isConnected) {
      return undefined;
    }

    const container = qrCodeRef.current!;

    if (STRICTERDOM_ENABLED) {
      disableStrict();
    }

    qrCode.update({
      data: internalQrPayload,
    });

    if (!isQrMounted) {
      qrCode.append(container);
      markQrMounted();
    }

    if (STRICTERDOM_ENABLED) {
      window.setTimeout(() => {
        enableStrict();
      }, QR_CODE_MUTATION_DURATION);
    }

    return undefined;
  }, [isConnected, authQrCode, internalQrPayload, isQrMounted, qrCode]);

  const handleBackNavigation = useLastCallback(() => {
    navigateBack();
  });

  const handleLangChange = useLastCallback(() => {
    markIsLoading();

    void oldSetLanguage(suggestedLanguage, () => {
      unmarkIsLoading();

      setSharedSettingOption({ language: suggestedLanguage });
    });
  });

  const handleReturnToAuthPhoneNumber = useLastCallback(() => {
    returnToAuthPhoneNumber();
  });

  const handleLoginWithPasskey = useLastCallback(() => {
    loginWithPasskey();
  });

  const isAuthReady = state === 'authorizationStateWaitQrCode';
  const shouldShowQrLoading = !internalQrPayload && !hasInternalQrFailed;

  return (
    <div id="auth-qr-form" className="custom-scroll">
      {hasActiveAccount && (
        <Button
          size="smaller"
          round
          color="translucent"
          className="auth-close"
          iconName="close"
          onClick={handleBackNavigation}
        />
      )}
      <div className="auth-form qr">
        <div className="qr-outer">
          {internalQrPayload ? (
            <div
              className={buildClassName('qr-inner', transitionClassNames)}
              key="qr-inner"
            >
              <div
                key="qr-container"
                className="qr-container"
                ref={qrCodeRef}
                style={`width: ${QR_SIZE}px; height: ${QR_SIZE}px`}
              />
              <img
                src={justChatLogoPath}
                alt=""
                width={QR_PLANE_SIZE}
                height={QR_PLANE_SIZE}
                className="qr-plane"
                draggable={false}
              />
            </div>
          ) : undefined}
          {shouldShowQrLoading && <div className="qr-loading"><Loading /></div>}
        </div>
        <h1>{lang('LoginQRInternalTitle')}</h1>
        {hasInternalQrFailed ? (
          <p className="auth-form-description">
            {lang('LoginQRInternalUnavailable')}
          </p>
        ) : (
          <ol>
            <li>
              <span>
                {lang('LoginQRInternalHelp1')}
              </span>
            </li>
            <li>
              <span>
                {lang('LoginQRInternalHelp2', undefined, { withNodes: true, withMarkdown: true })}
              </span>
            </li>
            <li>
              <span>
                {lang('LoginQRInternalHelp3')}
              </span>
            </li>
          </ol>
        )}
        {isAuthReady && (
          <Button className="auth-button" isText onClick={handleReturnToAuthPhoneNumber}>
            {lang('LoginQRCancel')}
          </Button>
        )}
        {passkeyOption && (
          <Button className="auth-button" isText onClick={handleLoginWithPasskey}>
            {lang('LoginPasskey')}
          </Button>
        )}
        {suggestedLanguage && suggestedLanguage !== language && continueText && (
          <Button className="auth-button" isText isLoading={isLoading} onClick={handleLangChange}>
            {continueText}
          </Button>
        )}
      </div>
    </div>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => {
    const {
      connectionState, auth,
    } = global;

    const { language } = selectSharedSettings(global);

    return {
      connectionState,
      auth,
      language,
    };
  },
)(AuthCode));
