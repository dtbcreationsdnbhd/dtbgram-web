import { ensureProtocol } from './url';
import { IS_MOBILE, IS_PWA } from './windowEnvironment';

const DESKTOP_POPUP_FEATURES = 'noopener,noreferrer,width=480,height=800';

export type OpenWebAppExternallyResult = 'popup' | 'tab' | 'failed';

/**
 * Opens a Mini App URL outside the in-app iframe.
 * Desktop uses a sized popup; mobile PWA opens the system browser tab.
 */
export function openWebAppExternally(url: string): OpenWebAppExternallyResult {
  const href = ensureProtocol(url);

  // Sized popups are unreliable in mobile PWAs; open a system browser tab instead.
  if (IS_PWA && IS_MOBILE) {
    const tab = window.open(href, '_blank', 'noopener,noreferrer');
    return tab ? 'tab' : 'failed';
  }

  const popup = window.open(href, '_blank', DESKTOP_POPUP_FEATURES);
  if (popup) {
    return 'popup';
  }

  // Popup blockers often still allow a plain tab after a user gesture.
  const tab = window.open(href, '_blank', 'noopener,noreferrer');
  return tab ? 'tab' : 'failed';
}
