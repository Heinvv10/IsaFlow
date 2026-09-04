/**
 * The depreciation run against a real database.
 *
 * A mocked `sql` template asserts the SHAPE of a statement, and a statement
 * Postgres would reject outright has exactly the same shape as one it accepts —
 * which is how `yearEndService.closeFiscalYear` shipped INSERTing two columns
 * that exist in no environment. This run writes four tables
 * (`asset_period_ledger`, `gl_journal_entries`, `gl_journal_lines`, `assets`)
 * and every one of them is exercised here for real.
 *
 * It also pins the correction made during the extraction: the journal's DATE
 * and NUMBER now come from `period_date`, not from today. Before, a run for
 * March executed in September posted a September-dated `DEP-<asset>-2026-09`
 * journal while the subledger recorded `202603`, so running two historical
 * periods in one calendar month wrote two subledger rows and ONE journal.
 *
 * DB-gated: skips (never fails) with no DB. Export DATABASE_URL or these do not
 * run at all.
 */
import { describe, it, expect, vi } from 'vitest';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests, sql } from '@/lib/neon';
import { runDepreciationTool } from '@/lib/mcp/tools/writeDepreciation';
import {
  runDepreciation,
  loadDepreciationAssets,
  planDepreciationRun,
  executeDepreciationRun,
  DepreciationRunBlockedError,
  DepreciationPlanMismatchError,
} from '@/modules/accounting/services/items/depreciationRunService';
import type { McpToolContext } from '@/lib/mcp/types';

type AlsCtx = Parameters<typeof als.run>[0];
const USER = '33333333-3333-3333-3333-333333333333';

function toolCtx(companyId: string): McpToolContext {
  return { userId: USER, companyId, scopes: ['write:post'] } as unknown as McpToolContext;
}

const json = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

/** A company with an OPEN period covering `date`, plus the two system accounts. */
async function seedCompany(date: string): Promise<string> {
  const co = (await sql`
    INSERT INTO companies (name) VALUES (${'RDEP fixture'}) RETURNING id
  `) as Array<{ id: string }>;
  const companyId = String(co[0]!.id);
  for (const [code, name, type, subtype] of [
    ['RDEP-5800', 'Depreciation Expense', 'expense', 'depreciation_expense'],
    ['RDEP-1230', 'Accumulated Depreciation', 'asset', 'accumulated_depreciation'],
  ] as const) {
    await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
                               account_subtype, normal_balance, is_active, is_system_account)
      VALUES (${companyId}::uuid, ${code}, ${name}, ${type}, ${subtype},
              ${type === 'expense' ? 'debit' : 'credit'}, ${true}, ${true})
    `;
  }
  await sql`
    INSERT INTO fiscal_periods (company_id, period_name, fiscal_year, period_number,
                                start_date, end_date, status)
    VALUES (${companyId}::uuid, ${'RDEP period'}, ${2031}, ${1},
            ${'2031-01-01'}::date, ${'2031-12-31'}::date, ${'open'})
  `;
  void date;
  return companyId;
}

async function addAsset(
  companyId: string, number: string, purchaseDate = '2030-01-01',
): Promise<string> {
  const rows = (await sql`
    INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price,
                        useful_life_years, accumulated_depreciation, current_book_value, status)
    VALUES (${companyId}::uuid, ${number}, ${`A ${number}`}, ${purchaseDate}::date,
            ${120000}, ${10}, ${0}, ${120000}, ${'available'})
    RETURNING id
  `) as Array<{ id: string }>;
  return String(rows[0]!.id);
}

async function inTx(run: (companyId: string) => Promise<void>): Promise<void> {
  assertNotProductionDb('This test creates a company, accounts, an asset and posts journals.');
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run(
      { client, userId: USER, companyId: 'bootstrap', claims: {} } as unknown as AlsCtx,
      async () => {
        const companyId = await seedCompany('2031-03-31');
        await als.run(
          { client, userId: USER, companyId, claims: {} } as unknown as AlsCtx,
          () => run(companyId),
        );
      },
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('run_depreciation — the real run against a real database', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('a dry run writes NOTHING to any of the four tables', async () => {
    await inTx(async (companyId) => {
      await addAsset(companyId, 'RDEP-A1');
      const res = await runDepreciationTool.handler(
        { period_date: '2031-03-31', dry_run: true, idempotency_key: 'dry' }, toolCtx(companyId),
      );
      expect(res.wroteNothing).toBe(true);
      const body = json(res);
      expect(body.journals).toHaveLength(1);
      expect(body.journals[0].date).toBe('2031-03-31');

      const ledger = (await sql`SELECT COUNT(*)::INT c FROM asset_period_ledger WHERE company_id = ${companyId}::uuid`) as Array<{ c: number }>;
      const entries = (await sql`SELECT COUNT(*)::INT c FROM gl_journal_entries WHERE company_id = ${companyId}::uuid`) as Array<{ c: number }>;
      expect(ledger[0]!.c).toBe(0);
      expect(entries[0]!.c).toBe(0);
    });
  });

  it.skipIf(!reachable)('the live run writes all four tables, and dates the journal by PERIOD', async () => {
    await inTx(async (companyId) => {
      const assetId = await addAsset(companyId, 'RDEP-A2');
      const body = json(await runDepreciationTool.handler(
        { period_date: '2031-03-31', idempotency_key: 'live' }, toolCtx(companyId),
      ));
      expect(body.processed).toBe(1);
      expect(body.glFailed).toBe(0);

      const entry = (await sql`
        SELECT entry_number, entry_date, source, fiscal_period_id
        FROM gl_journal_entries WHERE company_id = ${companyId}::uuid
      `) as Array<{ entry_number: string; entry_date: Date | string; source: string; fiscal_period_id: string | null }>;
      expect(entry).toHaveLength(1);
      // The correction: number and date both come from period_date, NOT today.
      expect(entry[0]!.entry_number).toBe('DEP-RDEP-A2-2031-03');
      expect(String(entry[0]!.entry_date)).toContain('2031-03-31');
      expect(entry[0]!.source).toBe('auto_depreciation');
      expect(entry[0]!.fiscal_period_id).not.toBeNull();

      const lines = (await sql`
        SELECT COUNT(*)::INT c, SUM(debit)::NUMERIC d, SUM(credit)::NUMERIC cr
        FROM gl_journal_lines WHERE company_id = ${companyId}::uuid
      `) as Array<{ c: number; d: string; cr: string }>;
      expect(lines[0]!.c).toBe(2);
      expect(Number(lines[0]!.d)).toBeCloseTo(Number(lines[0]!.cr), 2);

      const ledger = (await sql`
        SELECT yyyymm, policy_current_dep FROM asset_period_ledger
        WHERE company_id = ${companyId}::uuid AND asset_id = ${assetId}::uuid
      `) as Array<{ yyyymm: string; policy_current_dep: string }>;
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.yyyymm.trim()).toBe('203103');
      expect(Number(ledger[0]!.policy_current_dep)).toBeCloseTo(1000, 2);

      const asset = (await sql`
        SELECT accumulated_depreciation FROM assets WHERE id = ${assetId}::uuid
      `) as Array<{ accumulated_depreciation: string }>;
      expect(Number(asset[0]!.accumulated_depreciation)).toBeCloseTo(1000, 2);
    });
  });

  it.skipIf(!reachable)('a re-run of the same period posts nothing a second time', async () => {
    await inTx(async (companyId) => {
      await addAsset(companyId, 'RDEP-A3');
      await runDepreciationTool.handler(
        { period_date: '2031-03-31', idempotency_key: 'r1' }, toolCtx(companyId),
      );
      const again = await runDepreciationTool.handler(
        { period_date: '2031-03-31', idempotency_key: 'r2' }, toolCtx(companyId),
      );
      // A fresh idempotency key defeats the registry's replay guard, so the
      // entry-number guard is the one that has to hold. It refuses PRE-write.
      expect(again.isError).toBe(true);
      expect(again.content[0]!.text).toMatch(/already_posted/);

      const entries = (await sql`SELECT COUNT(*)::INT c FROM gl_journal_entries WHERE company_id = ${companyId}::uuid`) as Array<{ c: number }>;
      expect(entries[0]!.c).toBe(1);
    });
  });

  it.skipIf(!reachable)('TWO different periods in one calendar month post TWO journals', async () => {
    await inTx(async (companyId) => {
      await addAsset(companyId, 'RDEP-A4');
      await runDepreciationTool.handler(
        { period_date: '2031-03-31', idempotency_key: 'p1' }, toolCtx(companyId),
      );
      const second = json(await runDepreciationTool.handler(
        { period_date: '2031-04-30', idempotency_key: 'p2' }, toolCtx(companyId),
      ));
      expect(second.processed).toBe(1);

      const numbers = (await sql`
        SELECT entry_number FROM gl_journal_entries
        WHERE company_id = ${companyId}::uuid ORDER BY entry_number
      `) as Array<{ entry_number: string }>;
      // Under the old `DEP-<asset>-<today's month>` numbering both runs would
      // have collided on ONE number and the April journal would never have
      // posted, while asset_period_ledger recorded both periods.
      expect(numbers.map((n) => n.entry_number))
        .toEqual(['DEP-RDEP-A4-2031-03', 'DEP-RDEP-A4-2031-04']);
    });
  });

  it.skipIf(!reachable)('refuses a CLOSED period before writing anything', async () => {
    await inTx(async (companyId) => {
      await addAsset(companyId, 'RDEP-A5');
      await sql`UPDATE fiscal_periods SET status = ${'closed'} WHERE company_id = ${companyId}::uuid`;

      const res = await runDepreciationTool.handler(
        { period_date: '2031-03-31', idempotency_key: 'closed' }, toolCtx(companyId),
      );
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(/closed/i);

      const entries = (await sql`SELECT COUNT(*)::INT c FROM gl_journal_entries WHERE company_id = ${companyId}::uuid`) as Array<{ c: number }>;
      expect(entries[0]!.c).toBe(0);
    });
  });

  it.skipIf(!reachable)('refuses a date no fiscal period covers', async () => {
    await inTx(async (companyId) => {
      await addAsset(companyId, 'RDEP-A6');
      const res = await runDepreciationTool.handler(
        { period_date: '2029-03-31', idempotency_key: 'noperiod' }, toolCtx(companyId),
      );
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(/no fiscal period/i);
    });
  });
});

describe('the fixes from the blind review', async () => {
  const ok = await isDbReachable();

  it.skipIf(!ok)('REFUSES to depreciate an asset in a period before it was acquired', async () => {
    await inTx(async (companyId) => {
      // HIGH-1. calculatePolicyDepreciation decides its first-month pro-rate by
      // EQUALITY on purchase year and month, so a period BEFORE the purchase
      // matches neither branch and takes a FULL month's charge, capped only by
      // depreciableAmount - openingAccDep — a quantity unrelated to elapsed
      // time. It posts a dated journal AND permanently increments
      // assets.accumulated_depreciation, once per open pre-acquisition period.
      const assetId = await addAsset(companyId, 'RDEP-FUTURE', '2031-06-15');

      const res = await runDepreciationTool.handler(
        { period_date: '2031-03-31', idempotency_key: 'early' }, toolCtx(companyId),
      );
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(/not_yet_acquired/);

      const entries = (await sql`SELECT COUNT(*)::INT c FROM gl_journal_entries WHERE company_id = ${companyId}::uuid`) as Array<{ c: number }>;
      const ledger = (await sql`SELECT COUNT(*)::INT c FROM asset_period_ledger WHERE company_id = ${companyId}::uuid`) as Array<{ c: number }>;
      const asset = (await sql`SELECT accumulated_depreciation FROM assets WHERE id = ${assetId}::uuid`) as Array<{ accumulated_depreciation: string }>;
      expect(entries[0]!.c).toBe(0);
      expect(ledger[0]!.c).toBe(0);
      expect(Number(asset[0]!.accumulated_depreciation)).toBe(0);
    });
  });

  it.skipIf(!ok)('skips only the un-acquired asset, and still runs the rest', async () => {
    await inTx(async (companyId) => {
      // A PER-ASSET skip, not a whole-run blocker: a register holding one asset
      // bought last week must still run for the months before it.
      await addAsset(companyId, 'RDEP-OLD', '2030-01-01');
      await addAsset(companyId, 'RDEP-NEW', '2031-06-15');

      const body = json(await runDepreciationTool.handler(
        { period_date: '2031-03-31', idempotency_key: 'mixed' }, toolCtx(companyId),
      ));
      expect(body.processed).toBe(1);
      expect(body.skipped_assets.some(
        (s: { reason: string }) => s.reason === 'not_yet_acquired',
      )).toBe(true);

      const numbers = (await sql`
        SELECT entry_number FROM gl_journal_entries WHERE company_id = ${companyId}::uuid
      `) as Array<{ entry_number: string }>;
      expect(numbers.map((n) => n.entry_number)).toEqual(['DEP-RDEP-OLD-2031-03']);
    });
  });

  it.skipIf(!ok)('the dry run reports the un-acquired asset too, not silently', async () => {
    await inTx(async (companyId) => {
      await addAsset(companyId, 'RDEP-DRY-OLD', '2030-01-01');
      await addAsset(companyId, 'RDEP-DRY-NEW', '2031-06-15');
      const res = await runDepreciationTool.handler(
        { period_date: '2031-03-31', dry_run: true, idempotency_key: 'dry-mixed' }, toolCtx(companyId),
      );
      const body = json(res);
      expect(res.wroteNothing).toBe(true);
      expect(body.journalsTotal).toBe(1);
      expect(body.skipped.some((s: { reason: string }) => s.reason === 'not_yet_acquired')).toBe(true);
    });
  });

  it.skipIf(!ok)('the SERVICE refuses a non-canonical period_date — the REST route has no cast guard', async () => {
    await inTx(async (companyId) => {
      // LOW-9. The MCP tool is already fenced by guardCastableArgs, so a tool
      // test cannot see this guard at all — it is the REST route, which passes
      // req.body.periodDate straight through, that needs it. The guard lives in
      // the service precisely so the two callers cannot drift, and this test
      // reaches it the way the route does.
      await addAsset(companyId, 'RDEP-SVC-DATE');
      await expect(runDepreciation(companyId, USER, '2031-3-31'))
        .rejects.toThrow(DepreciationRunBlockedError);
      await expect(runDepreciation(companyId, USER, 'not-a-date'))
        .rejects.toThrow(/not a real calendar day/i);

      const entries = (await sql`SELECT COUNT(*)::INT c FROM gl_journal_entries WHERE company_id = ${companyId}::uuid`) as Array<{ c: number }>;
      expect(entries[0]!.c).toBe(0);
    });
  });

  it.skipIf(!ok)('REFUSES a non-canonical period_date that Postgres would accept', async () => {
    await inTx(async (companyId) => {
      // LOW-9. '2031-3-31' reaches a DATE column intact, but slice(0,7) gives
      // '2031-3-' and the entry number DEP-x-2031-3- does not collide with
      // DEP-x-2031-03 — so the already_posted guard never sees it and a second
      // March journal posts for the same asset.
      await addAsset(companyId, 'RDEP-BADDATE');
      await runDepreciationTool.handler(
        { period_date: '2031-03-31', idempotency_key: 'canon' }, toolCtx(companyId),
      );
      const res = await runDepreciationTool.handler(
        { period_date: '2031-3-31', idempotency_key: 'noncanon' }, toolCtx(companyId),
      );
      expect(res.isError).toBe(true);

      const entries = (await sql`SELECT COUNT(*)::INT c FROM gl_journal_entries WHERE company_id = ${companyId}::uuid`) as Array<{ c: number }>;
      expect(entries[0]!.c).toBe(1);
    });
  });

  it.skipIf(!ok)('processed + skipped + glFailed accounts for total', async () => {
    await inTx(async (companyId) => {
      // LOW-8. `total` was eligibleTotal while `skipped` counted every asset in
      // the company, so skipped > total was an ordinary response.
      await addAsset(companyId, 'RDEP-T1', '2030-01-01');
      await addAsset(companyId, 'RDEP-T2', '2031-06-15');
      await sql`
        INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price,
                            useful_life_years, accumulated_depreciation, current_book_value, status)
        VALUES (${companyId}::uuid, ${'RDEP-T3'}, ${'Disposed'}, ${'2030-01-01'}::date,
                ${9000}, ${5}, ${0}, ${9000}, ${'disposed'})
      `;
      const body = json(await runDepreciationTool.handler(
        { period_date: '2031-03-31', idempotency_key: 'counts' }, toolCtx(companyId),
      ));
      expect(body.processed + body.skipped + body.glFailed).toBe(body.total);
      expect(body.skipped).toBeLessThanOrEqual(body.total);
      // `eligible` carries the narrower count the old `total` held: T3 is out on
      // status, T2 is eligible but skipped on acquisition date.
      expect(body.eligible).toBe(2);
    });
  });

  it.skipIf(!ok)('a fully-depreciated asset appears in the dry run because the run still writes it', async () => {
    await inTx(async (companyId) => {
      // MEDIUM-7. postDualDepreciationToLedger UPSERTs asset_period_ledger
      // BEFORE it calls the journal writer, so an asset with no policy
      // depreciation left is written even though no journal posts. It used to
      // appear in neither `journals` nor `skipped`: a dry run showing nothing
      // for a call that writes a row.
      await sql`
        INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price,
                            useful_life_years, accumulated_depreciation, current_book_value,
                            tax_useful_life_years, status)
        VALUES (${companyId}::uuid, ${'RDEP-DONE'}, ${'Fully depreciated'}, ${'2030-01-01'}::date,
                ${60000}, ${1}, ${60000}, ${0}, ${20}, ${'available'})
      `;
      const preview = json(await runDepreciationTool.handler(
        { period_date: '2031-03-31', dry_run: true, idempotency_key: 'done-dry' }, toolCtx(companyId),
      ));
      expect(preview.journalsTotal).toBe(0);
      const noted = preview.skipped.find(
        (s: { reason: string }) => s.reason === 'subledger_row_only_no_journal',
      );
      expect(noted).toBeDefined();

      // And the live call does exactly what the preview said: no journal, one
      // subledger row.
      await runDepreciationTool.handler(
        { period_date: '2031-03-31', idempotency_key: 'done-live' }, toolCtx(companyId),
      );
      const entries = (await sql`SELECT COUNT(*)::INT c FROM gl_journal_entries WHERE company_id = ${companyId}::uuid`) as Array<{ c: number }>;
      const ledger = (await sql`SELECT COUNT(*)::INT c FROM asset_period_ledger WHERE company_id = ${companyId}::uuid`) as Array<{ c: number }>;
      expect(entries[0]!.c).toBe(0);
      expect(ledger[0]!.c).toBe(1);
    });
  });
});

describe('the published invariant is enforced, not documented', async () => {
  const ok6 = await isDbReachable();

  it.skipIf(!ok6)('a third caller that re-fetches between plan and execute is REFUSED, not under-reported', async () => {
    await inTx(async (companyId) => {
      // `if (!a) continue` accounted a postable row NOWHERE, so
      // processed + skipped + glFailed === total held only because both current
      // callers hand the same array to plan and execute. A third — a scheduled
      // close, a bureau batch — would have got a run that silently
      // under-reports its own population. That is the shape of partial run this
      // module already learned to count loudly as glFailed.
      await addAsset(companyId, 'RDEP-INV1');
      await addAsset(companyId, 'RDEP-INV2');
      const assets = await loadDepreciationAssets(companyId);
      const plan = await planDepreciationRun(companyId, '2031-03-31', assets);
      expect(plan.postable.length).toBe(2);

      // The caller re-fetched and lost one row between the two halves.
      await expect(
        executeDepreciationRun(companyId, USER, plan, assets.slice(0, 1)),
      ).rejects.toThrow(DepreciationPlanMismatchError);

      // It refuses BEFORE the first write, so there is nothing to unwind.
      const entries = (await sql`
        SELECT COUNT(*)::INT c FROM gl_journal_entries WHERE company_id = ${companyId}::uuid
      `) as Array<{ c: number }>;
      expect(entries[0]!.c).toBe(0);
    });
  });

  it.skipIf(!ok6)('the invariant holds on a run mixing posted, skipped and ineligible assets', async () => {
    await inTx(async (companyId) => {
      await addAsset(companyId, 'RDEP-INV-OK', '2030-01-01');
      await addAsset(companyId, 'RDEP-INV-NEW', '2031-06-15');
      await sql`
        INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price,
                            useful_life_years, accumulated_depreciation, current_book_value, status)
        VALUES (${companyId}::uuid, ${'RDEP-INV-GONE'}, ${'Disposed'}, ${'2030-01-01'}::date,
                ${1000}, ${5}, ${0}, ${1000}, ${'disposed'})
      `;
      const body = json(await runDepreciationTool.handler(
        { period_date: '2031-03-31', idempotency_key: 'inv' }, toolCtx(companyId),
      ));
      expect(body.processed + body.skipped + body.glFailed).toBe(body.total);
    });
  });
});
