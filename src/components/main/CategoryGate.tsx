// Blocks the logged-in app until the platform user has a category.
// GET /api/users?telegramUserId= checks assignment, GET /api/categories fills
// the dropdown, and POST /api/users/update (or create if the row is missing)
// saves the confirmed choice.

import {
  memo, useEffect, useLayoutEffect, useMemo, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { PlatformCategory } from '../../util/platformUsersApi';

import { getMainUsername, getUserFullName } from '../../global/helpers';
import { selectUser } from '../../global/selectors';
import buildClassName from '../../util/buildClassName';
import captureKeyboardListeners from '../../util/captureKeyboardListeners';
import {
  assignPlatformUserCategory,
  fetchPlatformCategories,
  fetchPlatformUser,
  formatPlatformPhoneNumber,
} from '../../util/platformUsersApi';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Icon from '../common/icons/Icon';
import Button from '../ui/Button';
import DropdownMenu from '../ui/DropdownMenu';
import MenuItem from '../ui/MenuItem';
import Portal from '../ui/Portal';
import Spinner from '../ui/Spinner';

import styles from './CategoryGate.module.scss';

type StateProps = {
  currentUserId?: string;
  username?: string;
  phoneNumber?: string;
};

type GateStep = 'loading' | 'select' | 'confirm' | 'error';

const CategoryGate = ({
  currentUserId,
  username,
  phoneNumber,
}: StateProps) => {
  const { signOut } = getActions();
  const lang = useLang();
  const [isBlocking, setIsBlocking] = useState(true);
  const [step, setStep] = useState<GateStep>('loading');
  const [categories, setCategories] = useState<PlatformCategory[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<'CategoryGateLoadError' | 'CategoryGateSaveError' | undefined>();

  const loadGate = useLastCallback(async () => {
    if (!currentUserId) {
      setIsBlocking(false);
      return;
    }

    setIsBlocking(true);
    setStep('loading');
    setErrorKey(undefined);

    const userResult = await fetchPlatformUser(currentUserId);

    if (userResult.status === 'skipped') {
      setIsBlocking(false);
      return;
    }

    if (userResult.status === 'error') {
      setErrorKey('CategoryGateLoadError');
      setStep('error');
      return;
    }

    if (userResult.user?.category) {
      setIsBlocking(false);
      return;
    }

    const categoryList = await fetchPlatformCategories();
    if (!categoryList?.length) {
      setErrorKey('CategoryGateLoadError');
      setStep('error');
      return;
    }

    setCategories(categoryList);
    setStep('select');
  });

  useEffect(() => {
    if (!currentUserId) {
      setIsBlocking(true);
      setStep('loading');
      return;
    }

    void loadGate();
  }, [currentUserId, loadGate]);

  useLayoutEffect(() => {
    if (!isBlocking) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isBlocking]);

  useEffect(() => {
    if (!isBlocking) {
      return undefined;
    }

    return captureKeyboardListeners({
      onEsc: () => true,
    });
  }, [isBlocking]);

  const handleSelectCategory = useLastCallback((categoryName: string) => {
    setSelectedCategory(categoryName);
  });

  const CategoryTrigger = useMemo(() => {
    return ({ onTrigger, isOpen }: { onTrigger: () => void; isOpen?: boolean }) => (
      <button
        type="button"
        className={buildClassName(
          styles.trigger,
          isOpen && styles.triggerOpen,
          selectedCategory && styles.triggerFilled,
        )}
        onClick={onTrigger}
      >
        <span className={selectedCategory ? styles.triggerValue : styles.triggerPlaceholder}>
          {selectedCategory || lang('CategoryGatePlaceholder')}
        </span>
        <Icon
          name="down"
          className={buildClassName(styles.triggerArrow, isOpen && styles.triggerArrowOpen)}
        />
      </button>
    );
  }, [lang, selectedCategory]);

  const handleConfirmChoice = useLastCallback(() => {
    if (!selectedCategory || isSubmitting) {
      return;
    }
    setStep('confirm');
  });

  const handleBackToSelect = useLastCallback(() => {
    if (isSubmitting) {
      return;
    }
    setStep('select');
  });

  const handleSubmit = useLastCallback(async () => {
    if (!currentUserId || !selectedCategory || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setErrorKey(undefined);

    const didSave = await assignPlatformUserCategory({
      telegramUserId: currentUserId,
      category: selectedCategory,
      username,
      phoneNumber,
    });

    setIsSubmitting(false);

    if (!didSave) {
      setErrorKey('CategoryGateSaveError');
      return;
    }

    setIsBlocking(false);
  });

  const handleRetry = useLastCallback(() => {
    void loadGate();
  });

  const handleSignOut = useLastCallback(() => {
    signOut({ forceInitApi: true });
  });

  const handleBlockEvent = useLastCallback((e: React.SyntheticEvent) => {
    e.stopPropagation();
  });

  if (!isBlocking) {
    return undefined;
  }

  return (
    <Portal className={styles.portal}>
      <div
        className={styles.root}
        role="presentation"
        onMouseDown={handleBlockEvent}
        onClick={handleBlockEvent}
        onTouchStart={handleBlockEvent}
      >
        <div
          className={styles.dialog}
          role="dialog"
          aria-modal="true"
          aria-labelledby="category-gate-title"
        >
          <h2 id="category-gate-title" className={styles.title}>
            {step === 'confirm' ? lang('CategoryGateConfirmTitle') : lang('CategoryGateTitle')}
          </h2>
          {step === 'loading' && (
            <div className={styles.loading}>
              <Spinner />
            </div>
          )}

          {step === 'error' && (
            <>
              <p className={styles.error}>{errorKey && lang(errorKey)}</p>
              <Button color="primary" isText onClick={handleRetry}>
                {lang('CategoryGateRetry')}
              </Button>
            </>
          )}

          {step === 'select' && (
            <>
              <p className={styles.description}>{lang('CategoryGateDescription')}</p>
              <DropdownMenu
                className={styles.dropdown}
                bubbleClassName={styles.menuBubble}
                trigger={CategoryTrigger}
                positionX="left"
                positionY="top"
                autoClose
              >
                {categories.map((category) => (
                  <MenuItem
                    key={category.id}
                    icon={selectedCategory === category.name ? 'check' : 'placeholder'}
                    onClick={() => {
                      handleSelectCategory(category.name);
                    }}
                  >
                    {category.name}
                  </MenuItem>
                ))}
              </DropdownMenu>
              <Button
                color="primary"
                disabled={!selectedCategory}
                onClick={handleConfirmChoice}
              >
                {lang('CategoryGateConfirm')}
              </Button>
              <Button
                className={styles.logout}
                color="secondary"
                iconName="logout"
                ariaLabel={lang('LogOutTitle')}
                onClick={handleSignOut}
              >
                {lang('LogOutTitle')}
              </Button>
            </>
          )}

          {step === 'confirm' && (
            <>
              <p className={styles.description}>
                {lang('CategoryGateConfirmChoice', { category: selectedCategory }, {
                  withNodes: true,
                  withMarkdown: true,
                })}
              </p>
              <p className={styles.warning}>{lang('CategoryGateConfirmWarning')}</p>
              {errorKey && <p className={styles.error}>{lang(errorKey)}</p>}
              <div className={styles.actions}>
                <Button
                  color="primary"
                  isLoading={isSubmitting}
                  disabled={isSubmitting}
                  onClick={handleSubmit}
                >
                  {lang('CategoryGateSubmit')}
                </Button>
                <Button
                  className={styles.logout}
                  color="secondary"
                  iconName="logout"
                  disabled={isSubmitting}
                  ariaLabel={lang('LogOutTitle')}
                  onClick={handleSignOut}
                >
                  {lang('LogOutTitle')}
                </Button>
                <Button
                  className={styles.back}
                  isText
                  disabled={isSubmitting}
                  onClick={handleBackToSelect}
                >
                  {lang('Cancel')}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </Portal>
  );
};

export default memo(withGlobal((global): Complete<StateProps> => {
  const { currentUserId } = global;
  const currentUser = currentUserId ? selectUser(global, currentUserId) : undefined;
  const username = currentUser
    ? (getMainUsername(currentUser) || getUserFullName(currentUser) || currentUser.id)
    : undefined;

  return {
    currentUserId,
    username,
    phoneNumber: formatPlatformPhoneNumber(currentUser?.phoneNumber)
      || formatPlatformPhoneNumber(global.auth.phoneNumber),
  };
})(CategoryGate));
