/**
 * SARS eFiling ISV configuration gate.
 *
 * The ISV VAT201 submit path is DARK by default: it activates only when the
 * master switch is on AND every credential is present. When any is missing,
 * getEfilingConfig() returns null, isEfilingConfigured() is false, and the
 * "Submit to SARS" surface never appears — the manual mark-as-submitted flow
 * remains the only option. Live submission is blocked on Hein's SARS ISV
 * registration (see docs/sars/2026-07-VAT201-isv-dossier.md).
 *
 * TWO-TIER model (per the dossier): Tier-1 = SARS onboards IsaFlow as an ISV
 * and issues the vendor channel/spec; Tier-2 = each taxpayer runs "ISV
 * Activation" in their own eFiling profile and gets a login-name + login-key
 * they enter into the product. This env config is the Tier-1 arming switch (+
 * vendor/acceptance-test credentials). Sourcing the per-taxpayer Tier-2
 * login-name/key from encrypted per-company storage is the documented
 * follow-up once Hein completes onboarding — the client already takes the
 * credential from the passed config, so that is a config-source swap, not a
 * transport change.
 *
 * Env vars (0600 / secret store, never committed):
 *   SARS_EFILING_ENABLED     'true' to arm the ISV channel
 *   SARS_EFILING_BASE_URL    ISV API base URL (https in production)
 *   SARS_EFILING_ISV_LOGIN   ISV login name (vendor/acceptance-test credential)
 *   SARS_EFILING_ISV_KEY     ISV login key / activation shared secret
 */

export interface EfilingConfig {
  baseUrl: string;
  isvLogin: string;
  activationKey: string;
}

/** Redacted status safe to return to the browser — never carries the key. */
export interface EfilingConfigStatus {
  configured: boolean;
  /** Hostname of the ISV base URL (for operator confidence), or null. */
  baseUrlHost: string | null;
  channel: 'isv';
}

function trimmed(name: string): string {
  return (process.env[name] ?? '').trim();
}

/**
 * Returns the ISV config only when fully armed and valid, else null.
 * Non-throwing by design so callers can branch without try/catch.
 */
export function getEfilingConfig(): EfilingConfig | null {
  if (trimmed('SARS_EFILING_ENABLED') !== 'true') return null;

  const baseUrl = trimmed('SARS_EFILING_BASE_URL');
  const isvLogin = trimmed('SARS_EFILING_ISV_LOGIN');
  const activationKey = trimmed('SARS_EFILING_ISV_KEY');
  if (!baseUrl || !isvLogin || !activationKey) return null;

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  // Production must be https and must not point at localhost; dev/test may use
  // http (e.g. the in-process mock server the contract tests stand up).
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    return null;
  }

  return { baseUrl, isvLogin, activationKey };
}

export function isEfilingConfigured(): boolean {
  return getEfilingConfig() !== null;
}

export function efilingConfigStatus(): EfilingConfigStatus {
  const cfg = getEfilingConfig();
  if (!cfg) return { configured: false, baseUrlHost: null, channel: 'isv' };
  let host: string | null = null;
  try {
    host = new URL(cfg.baseUrl).hostname;
  } catch {
    host = null;
  }
  return { configured: true, baseUrlHost: host, channel: 'isv' };
}
