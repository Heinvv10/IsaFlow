// src/lib/pdf/selectTransport.ts
//
// Which browser renders the page. Gotenberg (a container next to the
// WeasyPrint sidecar) in production, Playwright's bundled Chromium in dev and
// in tests. PDF_TRANSPORT=playwright forces the local one on a host that also
// has a container configured, which is how a production incident gets a
// same-shape fallback without an env teardown.

export type TransportName = 'playwright' | 'gotenberg';

export function chooseTransportName(env: NodeJS.ProcessEnv | Record<string, string | undefined>): TransportName {
  if (env.PDF_TRANSPORT === 'playwright') return 'playwright';
  if (env.PDF_TRANSPORT === 'gotenberg') return 'gotenberg';
  const url = (env.GOTENBERG_URL ?? '').trim();
  return url.length > 0 ? 'gotenberg' : 'playwright';
}
