import {
  memo, useCallback, useEffect, useRef, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { ApiUser } from '../../api/types';
import type { GlobalState } from '../../global/types';

import { COMPANY_OTP_CODE_LENGTH } from '../../config';
import { selectUser } from '../../global/selectors';
import { IS_TOUCH_ENV } from '../../util/browser/windowEnvironment';
import { formatPlatformPhoneNumber } from '../../util/platformUsersApi';

import useHistoryBack from '../../hooks/useHistoryBack';
import useLang from '../../hooks/useLang';

import Icon from '../common/icons/Icon';
import TrackingMonkey from '../common/TrackingMonkey';
import Button from '../ui/Button';
import InputText from '../ui/InputText';
import Loading from '../ui/Loading';

type StateProps = {
  auth: GlobalState['auth'];
  currentUser?: ApiUser;
};

const AuthCompanyOtp = ({
  auth,
  currentUser,
}: StateProps) => {
  const {
    verifyCompanyOtp,
    clearAuthErrorKey,
    signOut,
  } = getActions();

  const lang = useLang();
  const inputRef = useRef<HTMLInputElement>();

  const [code, setCode] = useState<string>('');
  const [isTracking, setIsTracking] = useState(false);
  const [trackingDirection, setTrackingDirection] = useState(1);

  const phoneNumber = formatPlatformPhoneNumber(currentUser?.phoneNumber)
    || formatPlatformPhoneNumber(auth.phoneNumber);
  const { isLoading, errorKey } = auth;

  useEffect(() => {
    if (!IS_TOUCH_ENV) {
      inputRef.current!.focus();
    }
  }, []);

  const handleSignOut = useCallback(() => {
    signOut({ forceInitApi: true });
  }, [signOut]);

  useHistoryBack({
    isActive: true,
    onBack: handleSignOut,
  });

  const onCodeChange = useCallback((e: React.FormEvent<HTMLInputElement>) => {
    if (errorKey) {
      clearAuthErrorKey();
    }

    const { currentTarget: target } = e;
    target.value = target.value.replace(/[^\d]+/, '').substr(0, COMPANY_OTP_CODE_LENGTH);

    if (target.value === code) {
      return;
    }

    setCode(target.value);

    if (!isTracking) {
      setIsTracking(true);
    } else if (!target.value.length) {
      setIsTracking(false);
    }

    if (code && code.length > target.value.length) {
      setTrackingDirection(-1);
    } else {
      setTrackingDirection(1);
    }

    if (target.value.length === COMPANY_OTP_CODE_LENGTH) {
      verifyCompanyOtp({ code: target.value });
    }
  }, [errorKey, code, isTracking, clearAuthErrorKey, verifyCompanyOtp]);

  return (
    <div id="auth-company-otp-form" className="custom-scroll">
      <div className="auth-form">
        <TrackingMonkey
          code={code}
          codeLength={COMPANY_OTP_CODE_LENGTH}
          isTracking={isTracking}
          trackingDirection={trackingDirection}
        />
        <h1>{lang('CompanyOtpTitle')}</h1>
        <p className="note">
          {phoneNumber
            ? lang('CompanyOtpSubtitle', { phone: phoneNumber }, { withNodes: true, withMarkdown: true })
            : lang('CompanyOtpTitle')}
        </p>
        <InputText
          ref={inputRef}
          id="company-otp-code"
          label={lang('Code')}
          onInput={onCodeChange}
          value={code}
          error={errorKey && lang.withRegular(errorKey)}
          autoComplete="off"
          inputMode="numeric"
          disabled={isLoading || !currentUser}
        />
        {isLoading && <Loading />}
        <Button
          className="auth-button"
          isText
          onClick={handleSignOut}
        >
          <Icon name="arrow-left" />
          {lang('LogOutTitle')}
        </Button>
      </div>
    </div>
  );
};

export default memo(withGlobal((global): Complete<StateProps> => {
  const currentUser = global.currentUserId
    ? selectUser(global, global.currentUserId)
    : undefined;

  return {
    auth: global.auth,
    currentUser,
  };
})(AuthCompanyOtp));
