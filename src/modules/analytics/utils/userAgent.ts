export interface ParsedUA {
  device: 'mobile' | 'tablet' | 'desktop';
  browser: string;
  os: string;
}

const BOT_RE = /bot|crawler|spider|crawling|slurp|mediapartners|facebookexternalhit|linkedinbot|twitterbot|discordbot|telegrambot|whatsapp|baiduspider|yandex|duckduckbot|applebot|pingdom|uptimerobot|headlesschrome|phantomjs|puppeteer|playwright|lighthouse|chrome-lighthouse|gtmetrix/i;

export function isBot(ua: string | null | undefined): boolean {
  if (!ua) return true;
  return BOT_RE.test(ua);
}

export function parseUserAgent(ua: string): ParsedUA {
  const s = ua || '';
  const lower = s.toLowerCase();

  const device: ParsedUA['device'] = /ipad|tablet|playbook|silk(?!.*mobile)/i.test(s)
    ? 'tablet'
    : /mobile|iphone|ipod|android.*mobile|blackberry|bb10|opera mini/i.test(s)
    ? 'mobile'
    : 'desktop';

  let browser = 'Other';
  if (lower.includes('edg/')) browser = 'Edge';
  else if (lower.includes('firefox/')) browser = 'Firefox';
  else if (lower.includes('opr/') || lower.includes('opera')) browser = 'Opera';
  else if (lower.includes('chrome/') && !lower.includes('chromium')) browser = 'Chrome';
  else if (lower.includes('safari/') && !lower.includes('chrome')) browser = 'Safari';
  else if (lower.includes('chromium')) browser = 'Chromium';

  let os = 'Other';
  if (/windows nt/i.test(s)) os = 'Windows';
  else if (/mac os x/i.test(s)) os = 'macOS';
  else if (/android/i.test(s)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(s)) os = 'iOS';
  else if (/linux/i.test(s)) os = 'Linux';
  else if (/cros/i.test(s)) os = 'ChromeOS';

  return { device, browser, os };
}

export function parseReferrer(ref: string | null | undefined): { domain: string | null; path: string | null } {
  if (!ref) return { domain: null, path: null };
  try {
    const u = new URL(ref);
    return { domain: u.hostname, path: u.pathname };
  } catch {
    return { domain: null, path: null };
  }
}

export interface ParsedUtm {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
}

function pick(params: URLSearchParams, key: string): string | null {
  const v = params.get(key);
  if (!v) return null;
  const t = v.trim().slice(0, 100);
  return t || null;
}

export function parseUtm(urlQuery: string | null | undefined): ParsedUtm {
  if (!urlQuery) return { source: null, medium: null, campaign: null, term: null, content: null };
  try {
    const params = new URLSearchParams(urlQuery);
    return {
      source:   pick(params, 'utm_source'),
      medium:   pick(params, 'utm_medium'),
      campaign: pick(params, 'utm_campaign'),
      term:     pick(params, 'utm_term'),
      content:  pick(params, 'utm_content'),
    };
  } catch {
    return { source: null, medium: null, campaign: null, term: null, content: null };
  }
}
