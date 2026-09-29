const TELEGRAM_INTERNAL_WEBAPP_HOSTS = new Set([
  'webappinternal.telegram.org',
  'botfather.telegram.org',
  'botbrother.telegram.org',
]);

/** Mini Apps hosted by Telegram that refuse third-party framing. */
export function isTelegramInternalWebAppUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    const lower = hostname.toLowerCase();
    return TELEGRAM_INTERNAL_WEBAPP_HOSTS.has(lower)
      || lower.includes('botfather')
      || lower.includes('botbrother');
  } catch {
    return false;
  }
}
