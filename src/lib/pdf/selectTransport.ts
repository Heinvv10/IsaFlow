// src/lib/pdf/selectTransport.ts
//
// Which browser renders the page. Gotenberg (a container next to the
// WeasyPrint sidecar) in production, Playwright's bundled Chromium in dev and
// in tests. PDF_TRANSPORT=playwright forces the local one on a host that also
// has a container configured, which is how a production incident gets a
// same-shape fallback without an env teardown.
//
// In production, an absent/blank GOTENBERG_URL is not a silent fallback to
// Playwright: it throws. Local Chromium in a production container is not the
// same-shape fallback it is in dev, so that path is only reachable by setting
// PDF_TRANSPORT=playwright deliberately.
//
// THE ALLOW-LIST, AND WHY THIS ONLY WARNS. The cookies carrying the print
// token are scoped to a bare `domain` (gotenbergForm.ts explains why: Gotenberg
// exposes no host-only or `url` cookie form), and a domain attribute matches
// subdomains. What contains that is the container's own
// `--chromium-allow-list`, which pins Chromium to the app host — so there is no
// subdomain for the widened cookie to be sent to. That flag lives on a docker
// run line, not in this repo: there is no compose file, no systemd unit and no
// env-check hook in scripts/deploy.sh to assert it against, and Gotenberg's
// /health and /version endpoints report neither its flags nor its
// configuration, so it cannot be verified programmatically either. The honest
// remaining lever is to make the assumption VISIBLE: an operator who has
// checked the running container sets GOTENBERG_ALLOW_LIST_VERIFIED=true, and
// until then every boot that selects this transport says so in the log.
//
// WHAT THE ALLOW-LIST ACTUALLY FILTERS — measured, 2026-09-07, because a
// blind security review's severity for the tenant `logoUrl` depended on it
// and the flag is not assertable from this repo.
//
// It filters SUBRESOURCES, not only navigation. Gotenberg 8 does not hand the
// pattern to Chromium at all: it runs Chromium behind its own pinning proxy
// (`chromium.browser.pinning-proxy`) and refuses every CONNECT and every
// forward whose URL does not match. Probed against `gotenberg/gotenberg:8`
// with an allow-list pinned to one host, converting a page on that host that
// carried two off-list `<img>` tags: both were refused by URL before any
// request left the container —
//
//   'https://ssrf-probe-subresource.example.net/logo.png' does not match any
//   expression from the allowed list: value filtered
//   'http://169-254-169-254.sslip.io/latest/meta-data/' does not match any
//   expression from the allowed list: value filtered
//
// — and the conversion still returned 200 with the images simply absent. So
// on the Gotenberg path a tenant logo hosted anywhere but the app host is not
// fetched at all, and an SSRF target certainly is not. The PLAYWRIGHT path has
// no equivalent — its request interception is scoped to the API paths the
// print page fetches and never sees an image load — which is why the logo URL
// is re-checked at compose time in `packBrand.resolvePackBrandForRender`
// rather than being left to the container.

import { log } from '@/lib/logger';

export type TransportName = 'playwright' | 'gotenberg';

/** Set to 'true' by an operator who has confirmed the running Gotenberg
 *  container carries --chromium-allow-list. See this file's header. */
export const ALLOW_LIST_VERIFIED_ENV = 'GOTENBERG_ALLOW_LIST_VERIFIED';

// Warned once per process: this runs on every render, and an unset flag would
// otherwise put a line in the log for every PDF export.
let warnedUnverified = false;

/** Exported for tests only — the flag is process-lifetime state. */
export function resetAllowListWarning(): void {
  warnedUnverified = false;
}

function chooseGotenberg(env: NodeJS.ProcessEnv | Record<string, string | undefined>): TransportName {
  if (env[ALLOW_LIST_VERIFIED_ENV] !== 'true' && !warnedUnverified) {
    warnedUnverified = true;
    log.warn('chooseTransportName: Gotenberg allow-list is unverified', {
      setting: ALLOW_LIST_VERIFIED_ENV,
      why: 'print-token cookies are scoped to a bare domain, which matches subdomains; the container\'s --chromium-allow-list is what contains that',
      action: 'confirm the container runs with --chromium-allow-list pinned to the app host, then set the flag',
    }, 'pdf');
  }
  return 'gotenberg';
}

export function chooseTransportName(env: NodeJS.ProcessEnv | Record<string, string | undefined>): TransportName {
  if (env.PDF_TRANSPORT === 'playwright') return 'playwright';
  if (env.PDF_TRANSPORT === 'gotenberg') return chooseGotenberg(env);

  const url = (env.GOTENBERG_URL ?? '').trim();
  if (url.length > 0) return chooseGotenberg(env);

  if (env.NODE_ENV === 'production') {
    const message = 'GOTENBERG_URL is required in production; set PDF_TRANSPORT=playwright to override deliberately';
    log.error('chooseTransportName: refusing silent Playwright fallback in production', {}, 'pdf');
    throw new Error(message);
  }

  return 'playwright';
}
