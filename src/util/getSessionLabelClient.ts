import {
  SESSION_LABEL_CLIENT,
  SESSION_LABEL_CLIENT_ANDROID_PWA,
  SESSION_LABEL_CLIENT_DESKTOP_EXE,
  SESSION_LABEL_CLIENT_DESKTOP_PWA,
  SESSION_LABEL_CLIENT_IOS_PWA,
} from '../config';
import { IS_ELECTRON, IS_TAURI } from './browser/globalEnvironment';
import {
  getIsPwa, IS_ANDROID, IS_IOS, PLATFORM_ENV,
} from './browser/windowEnvironment';

function getSessionOsLabel() {
  return PLATFORM_ENV || 'Unknown';
}

export default function getSessionLabelClient() {
  if (IS_TAURI || IS_ELECTRON) {
    return SESSION_LABEL_CLIENT_DESKTOP_EXE;
  }

  if (getIsPwa()) {
    if (IS_ANDROID) return SESSION_LABEL_CLIENT_ANDROID_PWA;
    if (IS_IOS) return SESSION_LABEL_CLIENT_IOS_PWA;
    return SESSION_LABEL_CLIENT_DESKTOP_PWA;
  }

  return SESSION_LABEL_CLIENT;
}

// Short name sent as `device_model` so the sessions list is not a raw user-agent string
export function getSessionDeviceModel() {
  const os = getSessionOsLabel();

  if (IS_TAURI || IS_ELECTRON) {
    return `Desktop EXE (${os})`;
  }

  if (getIsPwa()) {
    if (IS_ANDROID) return `Android PWA (${os})`;
    if (IS_IOS) return `iOS PWA (${os})`;
    return `Desktop PWA (${os})`;
  }

  return `Web (${os})`;
}
