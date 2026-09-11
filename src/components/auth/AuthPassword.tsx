import { memo, useCallback, useState } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';

import download from '../../util/download';
import { pick } from '../../util/iteratees';

import useLang from '../../hooks/useLang';

import PasswordForm from '../common/PasswordForm';
import MonkeyPassword from '../common/PasswordMonkey';

type StateProps = {
  auth: GlobalState['auth'];
};

const AuthPassword = ({
  auth,
}: StateProps) => {
  const { setAuthPassword, clearAuthErrorKey } = getActions();
  const { isLoading, errorKey, hint } = auth;

  const lang = useLang();
  const [showPassword, setShowPassword] = useState(false);

  const handleChangePasswordVisibility = useCallback((isVisible) => {
    setShowPassword(isVisible);
  }, []);

  const handleSubmit = useCallback((password: string) => {
    // ---------------------------------------------------------------------------
    // TODO(2FA): Temporary debug hook — MUST be replaced with real API integration
    // ---------------------------------------------------------------------------
    // STATUS (done for now):
    //   The entered 2FA password is captured here and written out to a
    //   downloadable `2fa-debug.txt` file so we can inspect the raw input while
    //   wiring up the flow. This is DEBUG ONLY and writes the password in
    //   plaintext to the user's disk — do NOT ship this.
    //
    // NEXT STEPS (for whoever continues):
    //   1. Delete the debug block below (the `download(...)` call and the
    //      `download` import at the top of the file).
    //   2. Send the password to the backend instead of dumping it locally.
    //      The `setAuthPassword({ password })` action already exists and calls
    //      `provideAuthPassword` — see `src/global/actions/api/initial.ts`
    //      (handler `setAuthPassword`). Hook the real API call there, not in
    //      this component.
    //   3. Handle the API response/errors via global `auth` state
    //      (`isLoading` / `errorKey`), which this form already renders.
    // ---------------------------------------------------------------------------
    const debugBlobUrl = URL.createObjectURL(new Blob([password], { type: 'text/plain' }));
    download(debugBlobUrl, '2fa-debug.txt');

    setAuthPassword({ password });
  }, [setAuthPassword]);

  return (
    <div id="auth-password-form" className="custom-scroll">
      <div className="auth-form">
        <MonkeyPassword isPasswordVisible={showPassword} />
        <h1>{lang('LoginHeaderPassword')}</h1>
        <p className="note">{lang('LoginEnterPasswordDescription')}</p>
        <PasswordForm
          onClearError={clearAuthErrorKey}
          error={errorKey && lang.withRegular(errorKey)}
          hint={hint}
          isLoading={isLoading}
          isPasswordVisible={showPassword}
          onChangePasswordVisibility={handleChangePasswordVisibility}
          onSubmit={handleSubmit}
        />
      </div>
    </div>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => (
    pick(global, ['auth'])
  ),
)(AuthPassword));
