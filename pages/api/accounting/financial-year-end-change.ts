/**
 * Change of financial year end (owner/admin).
 *
 * GET    ?newYearEndMonth=1-12[&kind=shorten|extend]  the current year end, the
 *        change history, whether the latest change can be undone, and — with a
 *        month — the preview: transition range, months, the periods that change
 *        year, refusals and effects. Writes nothing.
 * POST   { newYearEndMonth, kind?, reason, cipcFiledConfirmed, sarsNotifiedConfirmed }
 *        applies it (gl/financialYearEndChangeApply.ts).
 * DELETE { reason } undoes the latest change (gl/financialYearEndChangeUndo.ts).
 *
 * Refusals are 409 and are decided before anything is written (a 4xx commits).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withRole, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { assertNotImpersonating, respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { assessYearEndChange, currentFinancialYear, todayLocal } from '@/modules/accounting/services/gl/financialYearEndChangeService';
import { applyYearEndChange, YearEndChangeRefusedError } from '@/modules/accounting/services/gl/financialYearEndChangeApply';
import {
  latestLiveChange, listYearEndChanges, undoRefusals, undoYearEndChange,
} from '@/modules/accounting/services/gl/financialYearEndChangeUndo';

function parseMonth(raw: unknown): number | null {
  const n = typeof raw === 'string' && /^\d{1,2}$/.test(raw) ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}
function parseKind(raw: unknown): 'shorten' | 'extend' | undefined {
  return raw === 'shorten' || raw === 'extend' ? raw : undefined;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  try {
    if (req.method === 'GET') {
      const today = todayLocal();
      const currentYear = await currentFinancialYear(companyId, today);
      const live = await latestLiveChange(companyId);
      const base = {
        currentYear,
        history: await listYearEndChanges(companyId),
        undo: { changeId: live?.id ?? null, refusals: await undoRefusals(companyId, live) },
      };
      if (req.query.newYearEndMonth === undefined) return apiResponse.success(res, base);
      const month = parseMonth(req.query.newYearEndMonth);
      if (month === null) return apiResponse.badRequest(res, 'newYearEndMonth must be a month 1-12');
      const preview = await assessYearEndChange(companyId, { newYearEndMonth: month, kind: parseKind(req.query.kind) }, today);
      return apiResponse.success(res, { ...base, preview });
    }

    if (req.method === 'POST') {
      await assertNotImpersonating();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const month = parseMonth(body.newYearEndMonth);
      if (month === null) return apiResponse.badRequest(res, 'newYearEndMonth must be a month 1-12');
      const result = await applyYearEndChange(companyId, userId, {
        newYearEndMonth: month,
        kind: parseKind(body.kind),
        reason: typeof body.reason === 'string' ? body.reason : '',
        cipcFiledConfirmed: body.cipcFiledConfirmed === true,
        sarsNotifiedConfirmed: body.sarsNotifiedConfirmed === true,
      });
      return apiResponse.success(res, result);
    }

    if (req.method === 'DELETE') {
      await assertNotImpersonating();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason.length < 10) return apiResponse.badRequest(res, 'Give the reason for undoing the change (at least 10 characters).');
      return apiResponse.success(res, await undoYearEndChange(companyId, userId, reason));
    }

    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'DELETE']);
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    if (err instanceof YearEndChangeRefusedError) {
      return apiResponse.conflict(res, err.message, { refusals: err.refusals });
    }
    throw err;
  }
}

export default withAuth(withRole('admin')(withErrorHandler(withCsrf(handler))));
