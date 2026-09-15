import { memo, useLayoutEffect, useState } from '../../lib/teact/teact';

import { APP_LOCK_PASSWORD } from '../../config';
import buildClassName from '../../util/buildClassName';

import useLastCallback from '../../hooks/useLastCallback';

import styles from './AppLockGate.module.scss';

type OwnProps = {
  onUnlock: NoneToVoidFunction;
};

const KEYBOARD_OVERLAP_PX = 80;

// Rendered before the app is initialized, so `lang()` is not available here
const AppLockGate = ({ onUnlock }: OwnProps) => {
  const [password, setPassword] = useState('');
  const [hasError, setHasError] = useState(false);
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);

  useLayoutEffect(() => {
    const visualViewport = window.visualViewport;
    if (!visualViewport) {
      return undefined;
    }

    const updateKeyboardState = () => {
      setIsKeyboardOpen(window.innerHeight - visualViewport.height > KEYBOARD_OVERLAP_PX);
    };

    updateKeyboardState();
    visualViewport.addEventListener('resize', updateKeyboardState);
    visualViewport.addEventListener('scroll', updateKeyboardState);

    return () => {
      visualViewport.removeEventListener('resize', updateKeyboardState);
      visualViewport.removeEventListener('scroll', updateKeyboardState);
    };
  }, []);

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(e.currentTarget.value);
    setHasError(false);
  });

  const handleSubmit = useLastCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (password === APP_LOCK_PASSWORD) {
      onUnlock();
    } else {
      setHasError(true);
    }
  });

  return (
    <div className={buildClassName(styles.root, isKeyboardOpen && styles.rootKeyboard)}>
      <form className={styles.form} onSubmit={handleSubmit}>
        <h1 className={styles.title}>Enter Password</h1>
        <p className={styles.subtitle}>This app is locked. Enter the password to continue.</p>
        <input
          type="password"
          className={buildClassName(styles.input, hasError && styles.inputError)}
          value={password}
          autoFocus
          placeholder="Password"
          onChange={handleChange}
        />
        {hasError && <p className={styles.error}>Wrong password. Please try again.</p>}
        <button type="submit" className={styles.button} disabled={!password}>
          Unlock
        </button>
      </form>
    </div>
  );
};

export default memo(AppLockGate);
