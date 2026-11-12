/**
 * Client-home metric snapshot: the /home metric strip (direct client) and the
 * bureau Level 2 client home.
 *
 * Every figure is the headline figure (accounting reports/headlineFigures), the
 * one definition /accounting and Month-End read too: the posted ledger as at one
 * SAST day, nothing dated after it. cash is the ledger cash balance, ar and ap
 * the aged debtors and creditors totals, revenueMtd turnover and profitMtd net
 * profit from the 1st of the month to `asAt`.
 *
 * The CALLER must have already verified that the companyId belongs to the
 * authenticated user: either via getBureauClientForUser (the firm/bureau path,
 * /api/bureau/client/[companyId]) OR via withAuth's company_users membership
 * check on the active company (the direct-client path, /api/home). Every query
 * is scoped to the single companyId; this function adds no new tenant surface.
 */
import { getHeadlineFigures } from '@/modules/accounting/services/reports/headlineFigures';

export interface ClientMetrics {
  cash: number;
  ar: number;
  ap: number;
  revenueMtd: number;
  profitMtd: number;
  /** YYYY-MM-DD (SAST) the figures are stated at. */
  asAt: string;
}

export async function clientMetricsSnapshot(companyId: string): Promise<ClientMetrics> {
  const h = await getHeadlineFigures(companyId);
  return {
    cash: h.cash,
    ar: h.receivables.total,
    ap: h.payables.total,
    revenueMtd: h.revenueMtd,
    profitMtd: h.profitMtd,
    asAt: h.asAt,
  };
}
