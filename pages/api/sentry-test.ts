// Temporary BL-53 verification endpoint — delete after smoke test.
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';

async function handler(_req: NextApiRequest, _res: NextApiResponse) {
  throw new Error('BL-53 Sentry smoke test — intentional error to verify capture + scrub');
}

export default withErrorHandler(handler as any);
