const TELEGRAM_INTERNAL_WEBAPP_HOSTS = new Set([
  'webappinternal.telegram.org',
]);

const TG_WEBAPP_PARAM_PREFIX = 'tgWebApp';

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

function parseWebAppHostname(url: string): string | undefined {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return undefined;
    return hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function hostnameHasSuffix(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function isTelegramOrgHostname(hostname: string): boolean {
  return hostname === 'telegram.org' || hostname.endsWith('.telegram.org');
}

function isGoogleLikeHostname(hostname: string): boolean {
  return /(?:^|\.)google(?:\.[a-z]{2,3}){1,2}$/.test(hostname)
    || hostnameHasSuffix(hostname, 'gstatic.com')
    || hostnameHasSuffix(hostname, 'googleapis.com')
    || hostnameHasSuffix(hostname, 'googleusercontent.com');
}

/**
 * Hosts that fail in the Mini App iframe (docs refuse framing; Google returns 403).
 * Other sites keep the in-app WebView and the handshake fallback.
 */
export function shouldOpenWebAppInBrowser(url: string): boolean {
  if (isTelegramInternalWebAppUrl(url)) return false;

  const hostname = parseWebAppHostname(url);
  if (!hostname) return false;
  if (hostname.includes('botfather') || hostname.includes('botbrother')) return false;
  return isTelegramOrgHostname(hostname) || isGoogleLikeHostname(hostname);
}

/** Drop `tgWebApp*` query and hash params before opening the URL in a browser tab. */
export function stripTelegramWebAppParams(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.startsWith(TG_WEBAPP_PARAM_PREFIX)) {
        parsed.searchParams.delete(key);
      }
    }

    if (parsed.hash) {
      const hashParams = new URLSearchParams(parsed.hash.slice(1));
      let hasChanged = false;
      for (const key of [...hashParams.keys()]) {
        if (key.startsWith(TG_WEBAPP_PARAM_PREFIX)) {
          hashParams.delete(key);
          hasChanged = true;
        }
      }
      if (hasChanged) {
        const nextHash = hashParams.toString();
        parsed.hash = nextHash ? `#${nextHash}` : '';
      }
    }

    return parsed.toString();
  } catch {
    return url;
  }
}
