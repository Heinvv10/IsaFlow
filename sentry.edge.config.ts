import * as Sentry from '@sentry/nextjs';
import { scrubEvent } from './src/lib/sentry/scrub';

if (process.env.SENTRY_ENABLED === 'true' && process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    release: process.env.GIT_SHA || undefined,
    // Errors only. No tracing (any tracesSampleRate, even 0, switches it on), no metrics (on by default), no client reports, no sessions:
    // Bugsink accepts and ignores those envelopes, ~100 a minute from production (release-lead, 7 Nov 2026).
    enableMetrics: false,
    sendClientReports: false,
    beforeSend: (event, _hint) => scrubEvent(event),
  });
  Sentry.setTag('runtime', 'edge');
}
