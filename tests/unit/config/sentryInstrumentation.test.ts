/**
 * The Bugsink wiring: instrumentation.ts hands server request errors to Sentry (onRequestError), and next.config.js uploads source maps
 * only when scripts/deploy.sh asks for it (SENTRY_UPLOAD_SOURCEMAPS=true), never from CI, worktree or dev builds that see a token.
 */
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureRequestError } from '@sentry/nextjs';

vi.mock('../../../sentry.server.config', () => ({}));
vi.mock('../../../sentry.edge.config', () => ({}));

import { onRequestError } from '../../../instrumentation';

const require = createRequire(import.meta.url);

/** next.config.js loaded fresh under `env`, with withSentryConfig replaced by a recorder of the options it is given. */
function sentryOptions(env: Record<string, string | undefined>): { sourcemaps?: { disable?: boolean } } {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
  const configPath = require.resolve('../../../next.config.js');
  const sentryPath = require.resolve('@sentry/nextjs/config');
  let seen: { sourcemaps?: { disable?: boolean } } = {};
  const saved = require.cache[sentryPath];
  require.cache[sentryPath] = {
    id: sentryPath, filename: sentryPath, loaded: true,
    exports: { withSentryConfig: (cfg: unknown, opts: typeof seen) => { seen = opts; return cfg; } },
  } as unknown as NodeModule;
  delete require.cache[configPath];
  try {
    require(configPath);
  } finally {
    delete require.cache[configPath];
    if (saved) require.cache[sentryPath] = saved;
    else delete require.cache[sentryPath];
  }
  return seen;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('Sentry wiring', () => {
  it('onRequestError is Sentry.captureRequestError', () => {
    expect(typeof onRequestError).toBe('function');
    expect(onRequestError).toBe(captureRequestError);
  });

  it('uploads source maps only when SENTRY_UPLOAD_SOURCEMAPS=true and a token is set', () => {
    expect(sentryOptions({ SENTRY_AUTH_TOKEN: 'tok', SENTRY_UPLOAD_SOURCEMAPS: 'true' }).sourcemaps?.disable).toBe(false);
    expect(sentryOptions({ SENTRY_AUTH_TOKEN: 'tok', SENTRY_UPLOAD_SOURCEMAPS: undefined }).sourcemaps?.disable).toBe(true);
    expect(sentryOptions({ SENTRY_AUTH_TOKEN: 'tok', SENTRY_UPLOAD_SOURCEMAPS: '1' }).sourcemaps?.disable).toBe(true);
    expect(sentryOptions({ SENTRY_AUTH_TOKEN: undefined, SENTRY_UPLOAD_SOURCEMAPS: 'true' }).sourcemaps?.disable).toBe(true);
  });
});
