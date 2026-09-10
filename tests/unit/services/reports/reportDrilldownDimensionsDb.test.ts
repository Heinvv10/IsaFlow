import { describe, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';
import { als } from '@/lib/als';
import { getPoolForTests, sql } from '@/lib/neon';
import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';
import { isDbReachable } from '../../helpers/dbReachable';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
import transactions from '../../../../pages/api/accounting/reports-account-transactions';
import ledger from '../../../../pages/api/accounting/reports-account-ledger';
import evidence from '../../../../pages/api/accounting/evidence/trial-balance/[accountId]';

const company = '10000000-0000-4000-8000-000000000001';
const foreign = '10000000-0000-4000-8000-000000000002';
const legacy = '30000000-0000-4000-8000-000000000001';
const cc1 = '30000000-0000-4000-8000-000000000002';
const cc2 = '30000000-0000-4000-8000-000000000003';
const bu = '30000000-0000-4000-8000-000000000004';
const otherBu = '30000000-0000-4000-8000-000000000005';
const account = '50000000-0000-4000-8000-000000000001';
const range = { from: '2026-04-01', to: '2026-04-30', period_start: '2026-04-01', period_end: '2026-04-30' };

async function call(handler: typeof transactions, query: Record<string, unknown>) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
  await handler({ method: 'GET', companyId: company, query: {
    accountId: account, account_id: account, account_code: '1100', ...range, ...query,
  } } as never, res as unknown as NextApiResponse);
  return res;
}

// Connection-local tables only; no persistent accounting fixtures or customer writes.
async function withLedger(run: () => Promise<void>) {
  assertNotProductionDb('Temporary-table report drilldown regression');
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, companyId: company, userId: '', claims: {} }, async () => {
      await sql`CREATE TEMP TABLE IF NOT EXISTS gl_accounts (id uuid, company_id uuid, account_code text,
        account_name text, account_type text, normal_balance text) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE IF NOT EXISTS gl_journal_entries (id uuid, company_id uuid, status text, entry_date date,
        entry_number text, description text, reference text, source text, created_at timestamp,
        posting_agent text, extraction_confidence numeric, source_document_id uuid) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE IF NOT EXISTS gl_journal_lines (company_id uuid, journal_entry_id uuid, gl_account_id uuid,
        debit numeric, credit numeric, cost_center_id uuid, cc1_id uuid, cc2_id uuid, bu_id uuid) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE IF NOT EXISTS captured_documents (id uuid, company_id uuid, vendor_name text,
        reference_number text, document_date date) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE IF NOT EXISTS customer_invoices (id uuid, company_id uuid, gl_journal_entry_id uuid,
        source_document_id uuid, invoice_number text) ON COMMIT DROP`;
      await sql`INSERT INTO gl_accounts VALUES (${account}::uuid, ${company}::uuid, '1100', 'Fixture', 'asset', 'debit')`;
      for (const [n, date, amount, dimension, headerOwner, lineOwner, status] of [
        [1, '2026-03-04', 11, 'explicit', company, company, 'posted'],
        [2, '2026-03-04', 100, 'none', company, company, 'posted'],
        [3, '2026-04-04', 17, 'explicit', company, company, 'posted'],
        [4, '2026-04-05', 19, 'explicit', company, company, 'posted'],
        [5, '2026-04-06', 3, 'legacy', company, company, 'posted'],
        [6, '2026-04-04', 100, 'none', company, company, 'posted'],
        [7, '2026-04-04', 999, 'explicit', foreign, company, 'posted'],
        [8, '2026-04-04', 999, 'explicit', company, foreign, 'posted'],
        [9, '2026-04-07', 5, 'explicit', company, company, 'draft'],
        [10, '2026-05-04', 777, 'explicit', company, company, 'posted'],
      ] as const) {
        const id = `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
        await sql`INSERT INTO gl_journal_entries VALUES (${id}::uuid, ${headerOwner}::uuid, ${status}, ${date}::date,
          ${String(n)}, 'Fixture', '', 'manual', ${date}::timestamp, NULL, NULL, NULL)`;
        await sql`INSERT INTO gl_journal_lines VALUES (${lineOwner}::uuid, ${id}::uuid, ${account}::uuid, ${amount}, 0,
          ${dimension === 'none' ? null : legacy}::uuid, ${dimension === 'explicit' ? cc1 : null}::uuid,
          ${dimension === 'explicit' ? cc2 : null}::uuid,
          ${dimension === 'explicit' ? bu : dimension === 'legacy' ? otherBu : null}::uuid)`;
      }
      await run();
    });
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

describe('report drilldown filters', () => {
  it.each([transactions, ledger, evidence])('rejects malformed or repeated centre filters before querying', async handler => {
    for (const invalid of ['broken', '', [cc1], [cc1, cc2]]) {
      const res = await call(handler as typeof transactions, { cost_centre_id: invalid });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0]?.[0]).toMatchObject({ error: { message: 'cost_centre_id must be a valid UUID' } });
    }
  });
  it.each([transactions, ledger, evidence])('rejects malformed or repeated business-unit filters before querying', async handler => {
    for (const invalid of ['broken', '', [bu], [bu, foreign]]) {
      const res = await call(handler as typeof transactions, { business_unit_id: invalid });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0]?.[0]).toMatchObject({ error: { message: 'business_unit_id must be a valid UUID' } });
    }
  });
});

describe('report drilldown dimensions (Postgres)', async () => {
  const reachable = await isDbReachable();
  it.skipIf(!reachable)('carries each independent centre through transaction and evidence endpoints', async () => {
    await withLedger(async () => {
      for (const [selected, net, count, opening] of [[cc1, 36, 2, 11], [cc2, 36, 2, 11],
        [legacy, 39, 3, 11], [undefined, 139, 4, 111], [foreign, 0, 0, 0]] as const) {
        const tx = await call(transactions, { cost_centre_id: selected });
        expect(tx.json.mock.calls[0]?.[0].data).toMatchObject({ openingBalance: opening, closingBalance: opening + net });
        const ev = await call(evidence as typeof transactions, { cost_centre_id: selected });
        const data = ev.json.mock.calls[0]?.[0].data;
        expect(data.count).toBe(count);
        expect(data.rows.reduce((sum: number, row: { debit: number }) => sum + row.debit, 0)).toBe(net);
      }
    });
  });
  it.skipIf(!reachable)('carries business-unit and combined dimension filters through every drilldown endpoint', async () => {
    await withLedger(async () => {
      for (const handler of [transactions, ledger, evidence]) {
        const byBusinessUnit = await call(handler as typeof transactions, { business_unit_id: bu });
        const buData = byBusinessUnit.json.mock.calls[0]?.[0].data;
        if (handler === evidence) expect(buData).toMatchObject({ count: 2 });
        else if (handler === ledger) expect(buData).toMatchObject({ openingBalance: 11, total: 2, periodNet: 36, periodClosingBalance: 47 });
        else expect(buData).toMatchObject({ openingBalance: 11, closingBalance: 47, transactions: [{ debit: 17 }, { debit: 19 }] });

        const combined = await call(handler as typeof transactions, {
          cost_centre_id: legacy,
          business_unit_id: otherBu,
        });
        const combinedData = combined.json.mock.calls[0]?.[0].data;
        if (handler === evidence) expect(combinedData).toMatchObject({ count: 1 });
        else if (handler === ledger) expect(combinedData).toMatchObject({ openingBalance: 0, total: 1, periodNet: 3, periodClosingBalance: 3 });
        else expect(combinedData).toMatchObject({ openingBalance: 0, closingBalance: 3, transactions: [{ debit: 3 }] });
      }
    });
  });
  it.skipIf(!reachable)('resolves evidence account codes to the same company-owned account as UUIDs', async () => {
    await withLedger(async () => {
      const byId = await call(evidence as typeof transactions, { cost_centre_id: cc2 });
      const byCode = await call(evidence as typeof transactions, { accountId: '1100', cost_centre_id: cc2 });
      expect(byCode.json.mock.calls[0]?.[0].data).toEqual(byId.json.mock.calls[0]?.[0].data);
      await sql`INSERT INTO gl_accounts VALUES (${foreign}::uuid, ${foreign}::uuid, 'FOREIGN', 'Other tenant', 'asset', 'debit')`;
      const other = await call(evidence as typeof transactions, { accountId: 'FOREIGN' });
      expect(other.status).toHaveBeenCalledWith(404);
      const missing = await call(evidence as typeof transactions, { accountId: 'unknown' });
      expect(missing.status).toHaveBeenCalledWith(404);
    });
  });
  it.skipIf(!reachable)('keeps ledger opening/count/page/period/closing scoped in both status modes', async () => {
    await withLedger(async () => {
      for (const postedOnly of [true, false]) {
        for (const [selected, net, count, opening] of [[cc1, 36, 2, 11], [cc2, 36, 2, 11],
          [legacy, 39, 3, 11], [undefined, 139, 4, 111], [foreign, 0, 0, 0]] as const) {
          const draft = !postedOnly && selected !== foreign ? 5 : 0;
          const res = await call(ledger, { cost_centre_id: selected, posted_only: String(postedOnly), limit: '1', offset: '1' });
          expect(res.json.mock.calls[0]?.[0].data).toMatchObject({ openingBalance: opening,
            total: count + (draft ? 1 : 0), periodNet: net + draft, periodClosingBalance: opening + net + draft });
          const report = await getAccountLedger({ companyId: company, accountId: account, fromDate: range.from,
            toDate: range.to, postedOnly, costCentreId: selected, limit: 1, offset: 1 });
          expect(report.rows.map(row => row.debit)).toEqual(count ? [selected ? 19 : 100] : []);
        }
      }
    });
  });
});
