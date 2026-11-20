/**
 * Wave 6 FQd (review #1622): deleting a draft makes a vanished run id normal (a stale link, an open tab). Every run
 * route asked about a deleted run answers 404, never a 500 or a 400 hiding it: calculate, the variance report, the
 * parallel-run comparison and export (with the run named), and the R-035 approval request for the pay run.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { cleanup, type R } from './pe-payslip-email.helpers';
import runs from '../../pages/api/payroll/runs';
import runDetail from '../../pages/api/payroll/runs/[id]';
import variance from '../../pages/api/payroll/runs/[id]/variance';
import compare from '../../pages/api/payroll/parallel-run/compare';
import exportReport from '../../pages/api/payroll/parallel-run/export';
import approvalRequests from '../../pages/api/accounting/approval-requests';

type Res = { statusCode: number; body: { error?: { code?: string } } };
let a: R;
let gone = '';
let importId = '';

/** A GET with these query parameters, as the rig's own call does it (it sets only `id`). */
async function get(route: unknown, url: string, query: Record<string, string>): Promise<Res> {
  const req = request({ 'sb-access-token': a.tokens[a.admin]!, active_company_id: a.company }, 'GET') as never as {
    url: string; query: Record<string, unknown>;
  };
  req.query = query;
  req.url = url;
  const result = response();
  await (route as Route)(req as never, result.res as never);
  return result.state as Res;
}

beforeAll(async () => {
  a = await rig('fqd-not-found');
  await a.setup();
  await a.employee(20000);
  gone = String((await a.call(runs as Route, 'POST', '/api/payroll/runs', undefined, { body: { month: 5, year: 2026 } })).body.data!.id);
  expect((await a.call(runDetail as Route, 'DELETE', `/api/payroll/runs/${gone}`, gone)).statusCode).toBe(200);
  importId = String((await a.pool.query(
    "INSERT INTO payroll_external_imports (company_id, period_month, period_year, file_name) VALUES ($1, 5, 2026, 'may.csv') RETURNING id",
    [a.company])).rows[0]!.id);
}, 120_000);
afterAll(async () => {
  await a.pool.query('DELETE FROM payroll_external_imports WHERE company_id = $1', [a.company]);
  await cleanup(a);
});

describe('a deleted run id answers 404 on every run route', () => {
  it('calculate', async () => {
    const res = await a.api.calculate(gone);
    expect([res.statusCode, res.body.error?.code]).toEqual([404, 'NOT_FOUND']);
  });
  it('the variance report', async () => {
    const res = await get(variance, `/api/payroll/runs/${gone}/variance`, { id: gone });
    expect([res.statusCode, res.body.error?.code]).toEqual([404, 'NOT_FOUND']);
  });
  it('the parallel-run comparison and its export, naming the run', async () => {
    for (const route of [compare, exportReport]) {
      const res = await get(route, '/api/payroll/parallel-run/compare', { importId, runId: gone });
      expect([res.statusCode, res.body.error?.code]).toEqual([404, 'NOT_FOUND']);
    }
  });
  it('the R-035 approval request for the pay run', async () => {
    const res = await a.call(approvalRequests as Route, 'POST', '/api/accounting/approval-requests', undefined,
      { body: { action: 'request', documentType: 'pay_run', documentId: gone } });
    expect([res.statusCode, res.body.error?.code]).toEqual([404, 'NOT_FOUND']);
  });
});
