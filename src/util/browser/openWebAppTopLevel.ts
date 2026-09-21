const TELEGRAM_INTERNAL_WEBAPP_HOSTS = new Set([
  'webappinternal.telegram.org',
]);

/** Mini Apps hosted by Telegram that refuse third-party framing. */
export function isTelegramInternalWebAppUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return TELEGRAM_INTERNAL_WEBAPP_HOSTS.has(hostname.toLowerCase());
  } catch {
    return false;
  }
}
