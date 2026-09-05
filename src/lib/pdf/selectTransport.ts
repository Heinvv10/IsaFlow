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

import { log } from '@/lib/logger';

export type TransportName = 'playwright' | 'gotenberg';

export function chooseTransportName(env: NodeJS.ProcessEnv | Record<string, string | undefined>): TransportName {
  if (env.PDF_TRANSPORT === 'playwright') return 'playwright';
  if (env.PDF_TRANSPORT === 'gotenberg') return 'gotenberg';

  const url = (env.GOTENBERG_URL ?? '').trim();
  if (url.length > 0) return 'gotenberg';

  if (env.NODE_ENV === 'production') {
    const message = 'GOTENBERG_URL is required in production; set PDF_TRANSPORT=playwright to override deliberately';
    log.error('chooseTransportName: refusing silent Playwright fallback in production', {}, 'pdf');
    throw new Error(message);
  }

  return 'playwright';
}
