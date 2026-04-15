import * as Sentry from '@sentry/nextjs';
import { scrubEvent } from './src/lib/sentry/scrub';

if (process.env.SENTRY_ENABLED === 'true' && process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    release: process.env.GIT_SHA || undefined,
    tracesSampleRate: 0,
    includeLocalVariables: false,
    beforeSend: (event, _hint) => scrubEvent(event),
  });
  Sentry.setTag('runtime', 'node');
}
