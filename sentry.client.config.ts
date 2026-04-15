import * as Sentry from '@sentry/nextjs';
import { scrubEvent } from './src/lib/sentry/scrub';

if (
  typeof window !== 'undefined' &&
  process.env.NEXT_PUBLIC_SENTRY_ENABLED === 'true' &&
  process.env.NEXT_PUBLIC_SENTRY_DSN
) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_GIT_SHA || undefined,
    tracesSampleRate: 0,
    integrations: [],
    beforeSend: (event, _hint) => scrubEvent(event),
  });
  Sentry.setTag('runtime', 'browser');
}
