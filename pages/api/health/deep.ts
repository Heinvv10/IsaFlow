/**
 * Deep health endpoint (readiness probe).
 *
 * Runs DB + SMTP + Stitch checks in parallel, each with its own timeout.
 * - All ok → 200 { status: 'ok' }
 * - DB down → 503 { status: 'down' }
 * - DB ok, some non-DB dep down → 200 { status: 'degraded' }
 * - Dep skipped (not configured) → treated as 'ok' for the rollup
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { checkDb, checkSmtp, checkStitch, type CheckResult } from '@/lib/observability/deepChecks';

type DeepStatus = 'ok' | 'degraded' | 'down';

function rollup(db: CheckResult, rest: CheckResult[]): DeepStatus {
  if (db.status === 'down') return 'down';
  const anyDown = rest.some((c) => c.status === 'down');
  return anyDown ? 'degraded' : 'ok';
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ status: 'down', error: 'method_not_allowed' });
  }

  const [db, smtp, stitch] = await Promise.all([checkDb(), checkSmtp(), checkStitch()]);
  const status = rollup(db, [smtp, stitch]);
  const httpStatus = status === 'down' ? 503 : 200;

  return res.status(httpStatus).json({
    status,
    checks: { db, smtp, stitch },
  });
}
