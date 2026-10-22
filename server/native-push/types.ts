import type { PushNotificationContext } from '../../src/util/pushNotificationContext.ts';

export type ProbeSetup = {
  userId: string;
  nativeToken: string;
  appName: string;
  baseUrl: string;
  excludedChatIds: string[];
  context: PushNotificationContext;
};

export type Subscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export type ProbeConfig = ProbeSetup & {
  version: 1;
  createdAt: number;
  expiresAt: number;
  disabled: boolean;
  privateKey: string;
  subscription: Subscription;
};

export type FirebaseCredentials = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
};

export type NativeNotification = {
  title: string;
  body: string;
  url: string;
  tag: string;
  isSilent: boolean;
  unreadCount?: number;
};

export type PushDecision = {
  outcome: string;
  locKey?: string;
  notification?: NativeNotification;
  identity?: string;
};
