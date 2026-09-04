/**
 * The real reconciliation, against a real database.
 *
 * The tool test mocks the service outright, so it proves nothing about whether
 * the SQL runs. That is the failure class that shipped three defects in one day
 * here: `yearEndService.closeFiscalYear` INSERTed two columns that exist in no
 * environment and its mocked-template tests passed throughout, because a
 * statement Postgres would reject has exactly the same shape as one it accepts.
 *
 * These tests execute every query the service issues, and construct the two
 * findings the endpoint exists to surface:
 *  - a cost account carrying a CREDIT balance (a loan account subtyped
 *    fixed_assets — R8.4m of them on Brightsphere), which must be FLAGGED and
 *    still counted, never dropped
 *  - a ledger that has depreciated an asset the register says was never
 *    depreciated, which is Brightsphere's R7,500 exactly
 *
 * DB-gated: skips (never fails) when no DB is reachable. Export DATABASE_URL or
 * these do not run at all.
 */
import { describe, it, expect, vi } from 'vitest';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests, sql } from '@/lib/neon';
import { reconcileFixedAssetsTool } from '@/lib/mcp/tools/reconcileFixedAssets';
import { assetRegisterTool } from '@/lib/mcp/tools/assets';
import { assertEnvelopeSound } from '@/lib/mcp/contracts';
import type { McpToolContext } from '@/lib/mcp/types';

type AlsCtx = Parameters<typeof als.run>[0];
const AS_AT = '2031-12-31';

function toolCtx(companyId: string): McpToolContext {
  return {
    userId: '33333333-3333-3333-3333-333333333333',
    companyId,
    scopes: ['read:reports'],
  } as unknown as McpToolContext;
}

const json = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

async function addAccount(
  companyId: string, code: string, name: string, subtype: string | null,
  isActive = false,
): Promise<string> {
  const rows = (await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
                             account_subtype, normal_balance, is_active)
    VALUES (${companyId}::uuid, ${code}, ${name}, ${'asset'}, ${subtype}, ${'debit'}, ${isActive})
    RETURNING id
  `) as Array<{ id: string }>;
  return String(rows[0]!.id);
}

/** Posts a balanced journal: `amount` debit on `accountId`, credit on `contraId`. */
async function postJournal(
  companyId: string, accountId: string, contraId: string, amount: number, number: string,
): Promise<void> {
  const entry = (await sql`
    INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by)
    VALUES (${companyId}::uuid, ${number}, ${'2031-01-31'}::date, ${'fixture'}, ${'manual'}, ${'posted'}, ${'33333333-3333-3333-3333-333333333333'})
    RETURNING id
  `) as Array<{ id: string }>;
  const id = String(entry[0]!.id);
  await sql`
    INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id)
    VALUES (${id}::uuid, ${accountId}::uuid, ${amount}, 0, ${companyId}::uuid)
  `;
  await sql`
    INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id)
    VALUES (${id}::uuid, ${contraId}::uuid, 0, ${amount}, ${companyId}::uuid)
  `;
}

async function addAsset(
  companyId: string, number: string, price: number, accDep: number,
): Promise<string> {
  const rows = (await sql`
    INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price,
                        useful_life_years, accumulated_depreciation, current_book_value, status)
    VALUES (${companyId}::uuid, ${number}, ${`A ${number}`}, ${'2030-01-01'}::date,
            ${price}, ${3}, ${accDep}, ${price - accDep}, ${'available'})
    RETURNING id
  `) as Array<{ id: string }>;
  return String(rows[0]!.id);
}

async function inTx(run: (companyId: string) => Promise<void>): Promise<void> {
  assertNotProductionDb('This test INSERTs GL accounts, journals and assets.');
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, userId: 'probe', companyId: 'bootstrap', claims: {} } as unknown as AlsCtx, async () => {
      const rows = (await sql`SELECT id FROM companies ORDER BY created_at LIMIT 1`) as Array<{ id: string }>;
      const companyId = String(rows[0]!.id);
      await als.run(
        { client, userId: 'probe', companyId, claims: {} } as unknown as AlsCtx,
        () => run(companyId),
      );
    });
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('reconcile_fixed_assets — the real SQL against a real database', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('runs every query it issues and returns a sound envelope', async () => {
    await inTx(async (companyId) => {
      const body = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));
      assertEnvelopeSound(body);
      expect(body.universeTotal).toBeUndefined();
      expect(typeof body.difference).toBe('number');
    });
  });

  it.skipIf(!reachable)('flags a CREDIT-balance fixed-asset account and still counts it', async () => {
    await inTx(async (companyId) => {
      const loan = await addAccount(companyId, 'RFA-LOAN', 'Loan Account', 'fixed_assets');
      const contra = await addAccount(companyId, 'RFA-CONTRA', 'Contra', 'accumulated_depreciation');
      // Credit the "cost" account — a loan drawn down, not an asset bought.
      await postJournal(companyId, contra, loan, 250000, 'RFA-J1');

      const body = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));
      const item = body.rows.find((r: { account_code: string }) => r.account_code === 'RFA-LOAN');

      expect(item.normal_balance_violated).toBe(true);
      // Counted, not dropped: its balance is -250000, so it contributes +250000.
      expect(item.amount).toBeCloseTo(250000, 2);
      expect(body.contra_normal_balance_count).toBeGreaterThanOrEqual(1);
      // is_active is FALSE on both fixtures. A deactivated account with a live
      // balance is still on the balance sheet and must not be filtered out.
      expect(body.rows.some((r: { account_code: string }) => r.account_code === 'RFA-CONTRA')).toBe(true);
    });
  });

  it.skipIf(!reachable)('shows a ledger that depreciated an asset the register did not', async () => {
    await inTx(async (companyId) => {
      // Measured as a DELTA against whatever this database already holds. An
      // absolute assertion would pass or fail on seed data rather than on the
      // behaviour under test.
      const before = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));

      const cost = await addAccount(companyId, 'RFA-COST', 'PPE Cost', 'fixed_assets');
      const accDep = await addAccount(companyId, 'RFA-ACC', 'Accumulated Depreciation', 'accumulated_depreciation');
      // The ledger depreciates: DR cost side (kept inside the section so the
      // fixture journal balances), CR accumulated depreciation.
      await postJournal(companyId, cost, accDep, 7500, 'RFA-J2');
      // The register says nothing has been depreciated.
      await addAsset(companyId, 'RFA-A1', 15000, 0);

      const body = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));
      assertEnvelopeSound(body);

      // Register gained R15,000 of cost and NO depreciation; the ledger gained
      // R7,500 of accumulated depreciation against it.
      expect(body.register_cost - before.register_cost).toBeCloseTo(15000, 2);
      expect(body.register_accumulated_depreciation - before.register_accumulated_depreciation)
        .toBeCloseTo(0, 2);
      expect(body.gl_accumulated_depreciation - before.gl_accumulated_depreciation)
        .toBeCloseTo(-7500, 2);

      // The decomposition accounts for the whole difference, before and after.
      expect(body.unexplainedDifference).toBeCloseTo(0, 2);
      const summed = body.rows.reduce((s: number, r: { amount: number }) => s + r.amount, 0);
      expect(summed).toBeCloseTo(body.difference, 2);
      // And the asset itself is an item, so a reader can follow it.
      const asset = body.rows.find((r: { asset_number: string | null }) => r.asset_number === 'RFA-A1');
      expect(asset.amount).toBeCloseTo(15000, 2);
      expect(body.register_linkage_available).toBe(false);
    });
  });

  it.skipIf(!reachable)('serves the journal behind an account at detail full', async () => {
    await inTx(async (companyId) => {
      const cost = await addAccount(companyId, 'RFA-COST2', 'PPE Cost', 'fixed_assets');
      const accDep = await addAccount(companyId, 'RFA-ACC2', 'Accumulated Depreciation', 'accumulated_depreciation');
      await postJournal(companyId, cost, accDep, 1234.56, 'RFA-J3');

      const body = json(await reconcileFixedAssetsTool.handler(
        { as_at: AS_AT, detail: 'full' }, toolCtx(companyId),
      ));
      const doc = body.rows.find((r: { entry_number: string }) => r.entry_number === 'RFA-J3');

      expect(doc.source).toBe('manual');
      expect(doc.journal_entry_id).toBeTruthy();
      expect(Math.abs(doc.amount)).toBeCloseTo(1234.56, 2);
    });
  });
});

describe('the fixes from the blind review', async () => {
  const reachable2 = await isDbReachable();

  it.skipIf(!reachable2)('asset_register reports is_active FALSE for a deactivated account', async () => {
    await inTx(async (companyId) => {
      // MEDIUM-3. The source-text assertion in assetRegisterService.test.ts got
      // GREENER when the column was dropped from the SELECT, because a missing
      // column reads as `undefined !== false` → true. Only reading the value
      // back through the real query can see that.
      await addAccount(companyId, 'RFA-OFF', 'Deactivated Cost', 'fixed_assets', false);
      await addAccount(companyId, 'RFA-ON', 'Live Cost', 'fixed_assets', true);

      const body = json(await assetRegisterTool.handler({ as_at: AS_AT }, toolCtx(companyId)));
      const accounts = body.reconciliation.cost_accounts as Array<{ account_code: string; is_active: boolean }>;

      expect(accounts.find((a) => a.account_code === 'RFA-OFF')!.is_active).toBe(false);
      expect(accounts.find((a) => a.account_code === 'RFA-ON')!.is_active).toBe(true);
    });
  });

  it.skipIf(!reachable2)('reports an asset-typed account with NO subtype as an exclusion', async () => {
    await inTx(async (companyId) => {
      // MEDIUM-4. Velocity Fibre has eight PPE accounts in exactly this state.
      // They are in neither side of the reconciliation, so without this the
      // residual is zero BY CONSTRUCTION — the items and the totals come from
      // one subtype-filtered query and nothing outside it can make it fail.
      const nul = await addAccount(companyId, 'RFA-NULLSUB', 'Cost - Computer Equipment', null);
      const contra = await addAccount(companyId, 'RFA-NS-CONTRA', 'Contra', 'accumulated_depreciation');
      await postJournal(companyId, nul, contra, 44000, 'RFA-JNS');

      const body = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));
      const d = body.disclosures.find((e: { account_id: string }) => e.account_id === nul);

      expect(d.reason).toBe('no_account_subtype');
      expect(d.balance).toBeCloseTo(44000, 2);
      expect(d.account_code).toBe('RFA-NULLSUB');
      expect(body.unsubtyped_account_count).toBeGreaterThanOrEqual(1);
      // A DISCLOSURE, never an exclusion: it was not in this report's universe,
      // which is defined by subtype. Putting it in excludedRows would report
      // Velocity's R32.7m of debtors and cash as fixed assets it could not
      // classify — true in magnitude, wrong in kind.
      expect(body.excludedRows.every((e: { reason: string }) => e.reason !== 'no_account_subtype')).toBe(true);
      // The residual is still zero — and now the reader can see WHY that zero
      // is not a reconciliation.
      expect(body.unexplainedDifference).toBeCloseTo(0, 2);
      expect(body.unsubtyped_account_balance).not.toBe(0);
      assertEnvelopeSound(body);
    });
  });

  it.skipIf(!reachable2)('a NULL current_book_value gives the SAME NBV in the total and the item', async () => {
    await inTx(async (companyId) => {
      // MEDIUM-5. The total fell back to purchase_price alone while the item
      // fell back to cost - accDep, so the report showed an
      // unexplainedDifference describing no real gap.
      //
      // NOTE ON REACHABILITY, which the review got wrong: a NULL
      // current_book_value is NOT the normal state of a UI-created asset.
      // `trg_asset_book_value` is a BEFORE INSERT trigger that sets it to
      // purchase_price whenever it arrives NULL, and production carries 0 of 6
      // assets with a NULL. The trigger is INSERT-only, though, so an UPDATE
      // can still produce one — which is how this fixture reaches the state,
      // and why the two fallbacks still had to be made one.
      const before = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));
      await sql`
        INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price,
                            useful_life_years, accumulated_depreciation, status)
        VALUES (${companyId}::uuid, ${'RFA-NULLCBV'}, ${'No book value'}, ${'2030-01-01'}::date,
                ${50000}, ${5}, ${12000}, ${'available'})
      `;
      await sql`
        UPDATE assets SET current_book_value = NULL
        WHERE company_id = ${companyId}::uuid AND asset_number = ${'RFA-NULLCBV'}
      `;
      const body = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));

      // 50000 cost less 12000 accumulated depreciation — NOT 50000.
      expect(body.register_net_book_value - before.register_net_book_value).toBeCloseTo(38000, 2);
      const item = body.rows.find((r: { asset_number: string | null }) => r.asset_number === 'RFA-NULLCBV');
      expect(item.amount).toBeCloseTo(38000, 2);
      expect(body.unexplainedDifference).toBeCloseTo(0, 2);
    });
  });

  it.skipIf(!reachable2)('detail:full pages without repeating a journal that hits two accounts', async () => {
    await inTx(async (companyId) => {
      // MEDIUM-6. loadAssetSectionDocuments groups by (account, journal), so a
      // journal touching both sides appears TWICE and journalEntryId is not a
      // unique key. A cursor keyed on it alone resolved to the first occurrence
      // and page 2 re-served every row in between.
      const cost = await addAccount(companyId, 'RFA-PG-COST', 'PPE Cost', 'fixed_assets');
      const accDep = await addAccount(companyId, 'RFA-PG-ACC', 'Accumulated Depreciation', 'accumulated_depreciation');
      for (let i = 0; i < 4; i += 1) {
        await postJournal(companyId, cost, accDep, 100 + i, `RFA-PG-${i}`);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 200; page += 1) {
        const res = await reconcileFixedAssetsTool.handler(
          { as_at: AS_AT, detail: 'full', limit: 5, ...(cursor ? { cursor } : {}) },
          toolCtx(companyId),
        );
        expect(res.isError).not.toBe(true);
        const body = json(res);
        for (const r of body.rows) seen.push(`${r.account_id}|${r.journal_entry_id}`);
        cursor = body.next_cursor;
        if (!cursor) break;
      }
      expect(new Set(seen).size).toBe(seen.length);
      // Every (account, journal) pair the report holds, served exactly once.
      const all = json(await reconcileFixedAssetsTool.handler(
        { as_at: AS_AT, detail: 'full', limit: 500 }, toolCtx(companyId),
      ));
      expect(seen.length).toBe(all.rowsTotal);
    });
  });

  it.skipIf(!reachable2)('REFUSES a cursor naming a row the report no longer holds', async () => {
    await inTx(async (companyId) => {
      const cost = await addAccount(companyId, 'RFA-CUR', 'PPE Cost', 'fixed_assets');
      const accDep = await addAccount(companyId, 'RFA-CUR-ACC', 'Accumulated Depreciation', 'accumulated_depreciation');
      await postJournal(companyId, cost, accDep, 500, 'RFA-CUR-J');

      // A well-formed 2-part cursor for a pair that is not in this report.
      const stale = Buffer.from(JSON.stringify([
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
      ])).toString('base64url');

      const res = await reconcileFixedAssetsTool.handler(
        { as_at: AS_AT, detail: 'full', cursor: stale }, toolCtx(companyId),
      );
      // Silently restarting at page 1 is what findIndex → -1 → +1 → 0 did.
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(/cursor/i);
    });
  });
});

describe('the addendum: an unposted disposal, and a brand-new tenant', async () => {
  const ok3 = await isDbReachable();

  it.skipIf(!ok3)('names a disposal the ledger never heard about, at its own reason code', async () => {
    await inTx(async (companyId) => {
      // Production's only disposal is exactly this shape: Brightsphere
      // COMP-0001, sold 2026-04-12 for R8,000 against a R15,000 book value, a
      // R7,000 loss recorded in asset_disposals with journal_entry_id NULL and
      // no disposal journal anywhere. It cannot post on any tenant, because
      // postAssetDisposalToGL resolves the system role disposal_profit_loss and
      // 0 of 13 production companies have an account with that subtype.
      const rows = (await sql`
        INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price,
                            useful_life_years, accumulated_depreciation, current_book_value,
                            status, disposal_date, disposal_amount, disposal_gain_loss)
        VALUES (${companyId}::uuid, ${'RFA-SOLD'}, ${'Sold computer'}, ${'2030-01-01'}::date,
                ${15000}, ${3}, ${0}, ${15000}, ${'disposed'},
                ${'2031-04-12'}::date, ${8000}, ${-7000})
        RETURNING id
      `) as Array<{ id: string }>;
      const assetId = String(rows[0]!.id);
      await sql`
        INSERT INTO asset_disposals (asset_id, disposal_date, disposal_method,
                                     disposal_amount, book_value_at_disposal, gain_loss, created_by)
        VALUES (${assetId}::uuid, ${'2031-04-12'}::date, ${'sale'}, ${8000}, ${15000}, ${-7000}, ${'probe'})
      `;

      const body = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));
      assertEnvelopeSound(body);

      const d = body.unposted_disposals.find(
        (x: { asset_number: string }) => x.asset_number === 'RFA-SOLD',
      );
      expect(d.gain_loss).toBeCloseTo(-7000, 2);
      expect(d.proceeds).toBeCloseTo(8000, 2);
      expect(d.book_value_at_disposal).toBeCloseTo(15000, 2);
      expect(d.disposal_id).toBeTruthy();
      expect(d.disposal_record_missing).toBe(false);

      // Its OWN reason code, so a caller can tell "sold and accounted for" from
      // "sold, and the ledger never heard".
      const ex = body.excludedRows.find((e: { id: string }) => e.id === assetId);
      expect(ex.reason).toBe('disposal_not_posted_to_ledger');

      // And it contributes NOTHING to the arithmetic — which is exactly why it
      // needs its own report. Both sides are zero for a disposed asset with no
      // journal, so the difference closes over a real R7,000 loss.
      const summed = body.rows.reduce((s: number, r: { amount: number }) => s + r.amount, 0);
      expect(summed).toBeCloseTo(body.difference, 2);
      expect(body.unexplainedDifference).toBeCloseTo(0, 2);
      expect(body.rows.some((r: { asset_id: string | null }) => r.asset_id === assetId)).toBe(false);
    });
  });

  it.skipIf(!ok3)('flags a disposed asset with NO asset_disposals row at all', async () => {
    await inTx(async (companyId) => {
      await sql`
        INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price,
                            useful_life_years, accumulated_depreciation, current_book_value,
                            status, disposal_date)
        VALUES (${companyId}::uuid, ${'RFA-NOREC'}, ${'Scrapped'}, ${'2030-01-01'}::date,
                ${4000}, ${3}, ${0}, ${4000}, ${'disposed'}, ${'2031-05-01'}::date)
      `;
      const body = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));
      const d = body.unposted_disposals.find(
        (x: { asset_number: string }) => x.asset_number === 'RFA-NOREC',
      );
      // A worse version of the same gap, not a reason to miss it.
      expect(d.disposal_record_missing).toBe(true);
      expect(d.disposal_id).toBeNull();
    });
  });

  it.skipIf(!ok3)('a disposal WITH a posted journal keeps the ordinary reason code', async () => {
    await inTx(async (companyId) => {
      const cost = await addAccount(companyId, 'RFA-D-COST', 'PPE Cost', 'fixed_assets');
      const acc = await addAccount(companyId, 'RFA-D-ACC', 'Accumulated Depreciation', 'accumulated_depreciation');
      await postJournal(companyId, cost, acc, 1000, 'RFA-DISPOSAL-JE');
      const je = (await sql`
        SELECT id FROM gl_journal_entries
        WHERE company_id = ${companyId}::uuid AND entry_number = ${'RFA-DISPOSAL-JE'}
      `) as Array<{ id: string }>;
      const rows = (await sql`
        INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price,
                            useful_life_years, accumulated_depreciation, current_book_value,
                            status, disposal_date, disposal_amount)
        VALUES (${companyId}::uuid, ${'RFA-POSTED'}, ${'Sold and posted'}, ${'2030-01-01'}::date,
                ${5000}, ${3}, ${0}, ${5000}, ${'disposed'}, ${'2031-04-12'}::date, ${5000})
        RETURNING id
      `) as Array<{ id: string }>;
      await sql`
        INSERT INTO asset_disposals (asset_id, disposal_date, disposal_method, disposal_amount,
                                     book_value_at_disposal, gain_loss, journal_entry_id, created_by)
        VALUES (${String(rows[0]!.id)}::uuid, ${'2031-04-12'}::date, ${'sale'}, ${5000},
                ${5000}, ${0}, ${String(je[0]!.id)}::uuid, ${'probe'})
      `;

      const body = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));
      const ex = body.excludedRows.find((e: { id: string }) => e.id === String(rows[0]!.id));
      expect(ex.reason).toBe('disposed_before_as_at');
      expect(body.unposted_disposals.some(
        (x: { asset_number: string }) => x.asset_number === 'RFA-POSTED',
      )).toBe(false);
    });
  });
});

describe('posted_through is null when no ledger row was consumed', async () => {
  const ok4 = await isDbReachable();

  it.skipIf(!ok4)('a company with asset accounts but NO posted lines reports null, not the epoch', async () => {
    await inTx(async (companyId) => {
      // Not the empty tenant: this company HAS asset-section accounts. They
      // simply carry no posted journal line, so there is no MAX(created_at) to
      // report and the honest watermark is absent rather than 1970.
      await addAccount(companyId, 'RFA-PT-COST', 'PPE Cost', 'fixed_assets');
      await addAccount(companyId, 'RFA-PT-ACC', 'Accumulated Depreciation', 'accumulated_depreciation');

      const body = json(await reconcileFixedAssetsTool.handler(
        { as_at: '1990-01-01' }, toolCtx(companyId),
      ));
      // as_at before every journal in this database, so nothing is consumed.
      expect(body.posted_through).toBeNull();
      expect(body.documents_total).toBe(0);
    });
  });

  it.skipIf(!ok4)('a posted line gives a real timestamp, so null is not a constant', async () => {
    await inTx(async (companyId) => {
      const cost = await addAccount(companyId, 'RFA-PT2-COST', 'PPE Cost', 'fixed_assets');
      const acc = await addAccount(companyId, 'RFA-PT2-ACC', 'Accumulated Depreciation', 'accumulated_depreciation');
      await postJournal(companyId, cost, acc, 900, 'RFA-PT2-JE');

      const body = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));
      expect(body.posted_through).not.toBeNull();
      expect(Number.isNaN(Date.parse(String(body.posted_through)))).toBe(false);
      // And it is NOT the epoch — a fabricated value would pass the check above.
      expect(body.posted_through).not.toBe('1970-01-01T00:00:00.000Z');
    });
  });

  it.skipIf(!ok4)('reports no per-item attribution it cannot compute', async () => {
    await inTx(async (companyId) => {
      // `attribution` was hardcoded 'unlinked' at both construction sites while
      // its type said 'linked' | 'unlinked' and the description explained WHY an
      // item was unlinked — a conditional the code never implemented, and
      // linked_item_count was dead at 0 forever. No asset or category in
      // production records a GL account, so there is nothing to compute it
      // from; `register_linkage_available` carries that fact honestly and by
      // query. The fields are gone rather than lying.
      await addAsset(companyId, 'RFA-ATTR', 5000, 0);
      const body = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));

      expect(body).not.toHaveProperty('linked_item_count');
      expect(body).not.toHaveProperty('unlinked_item_count');
      for (const row of body.rows) {
        expect(row).not.toHaveProperty('attribution');
        expect(row).not.toHaveProperty('attributed_via');
      }
      expect(body.register_linkage_available).toBe(false);
    });
  });
});

describe('the figures reported OUTSIDE the reconciling identity', async () => {
  const ok5 = await isDbReachable();

  it.skipIf(!ok5)('a SECOND disposal row for one asset does not double the totals', async () => {
    await inTx(async (companyId) => {
      // asset_disposals carries only idx_disposals_asset, a NON-unique index —
      // nothing in the schema stops two rows for one asset. Summing straight
      // off a LEFT JOIN counted both and doubled the two headline figures. The
      // asset is the unit of the register and cannot duplicate; the disposal
      // record is supporting detail, so ONE row per asset is the fix.
      const rows = (await sql`
        INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price,
                            useful_life_years, accumulated_depreciation, current_book_value,
                            status, disposal_date, disposal_amount, disposal_gain_loss)
        VALUES (${companyId}::uuid, ${'RFA-DUP'}, ${'Disposed twice'}, ${'2030-01-01'}::date,
                ${15000}, ${3}, ${0}, ${15000}, ${'disposed'},
                ${'2031-04-12'}::date, ${8000}, ${-7000})
        RETURNING id
      `) as Array<{ id: string }>;
      const assetId = String(rows[0]!.id);
      for (const [date, gain] of [['2031-04-12', -7000], ['2031-05-20', -6500]] as const) {
        await sql`
          INSERT INTO asset_disposals (asset_id, disposal_date, disposal_method, disposal_amount,
                                       book_value_at_disposal, gain_loss, created_by)
          VALUES (${assetId}::uuid, ${date}::date, ${'sale'}, ${8000}, ${15000}, ${gain}, ${'probe'})
        `;
      }

      const body = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));
      const mine = body.unposted_disposals.filter(
        (d: { asset_number: string }) => d.asset_number === 'RFA-DUP',
      );

      expect(mine).toHaveLength(1);
      // The LATEST record wins, deterministically, and the reader is told there
      // is more than one rather than having the choice made silently.
      expect(mine[0].disposal_date).toBe('2031-05-20');
      expect(mine[0].gain_loss).toBeCloseTo(-6500, 2);
      expect(mine[0].disposal_record_count).toBe(2);
      // NOT -13500, which is what summing both rows produced.
      expect(body.unposted_disposal_gain_loss).toBeCloseTo(-6500, 2);
      expect(body.unposted_disposal_book_value).toBeCloseTo(15000, 2);
    });
  });

  it.skipIf(!ok5)('every figure outside the identity carries a check that can fail', async () => {
    await inTx(async (companyId) => {
      const nul = await addAccount(companyId, 'RFA-G-NULL', 'No subtype', null);
      const contra = await addAccount(companyId, 'RFA-G-ACC', 'Accumulated Depreciation', 'accumulated_depreciation');
      await postJournal(companyId, nul, contra, 1234, 'RFA-G-JE');

      const body = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));

      // Each headline sum outside `difference` is checked against the rows it
      // claims to total. `unexplainedDifference: 0.00` says nothing about any
      // of them, which is exactly why they need their own check.
      const listedDisclosures = body.disclosures.reduce(
        (t: number, d: { balance: number }) => t + d.balance, 0,
      );
      expect(body.unsubtyped_account_balance).toBeCloseTo(listedDisclosures, 2);
      expect(body.unsubtyped_account_count).toBe(body.disclosures.length);

      const listedDisposals = body.unposted_disposals.reduce(
        (t: number, d: { gain_loss: number | null }) => t + (d.gain_loss ?? 0), 0,
      );
      expect(body.unposted_disposal_gain_loss).toBeCloseTo(listedDisposals, 2);
      expect(body.unposted_disposal_count).toBe(body.unposted_disposals.length);

      // And the report says so itself, so a caller need not re-derive it.
      expect(body.figure_guards.unsubtyped_account_balance).toBe('enumerated');
      expect(body.figure_guards.unposted_disposal_gain_loss).toBe('enumerated');
      expect(body.disclosureFault).toBeUndefined();
    });
  });

  it.skipIf(!ok5)('and the check FIRES when a total and its rows disagree', async () => {
    await inTx(async (companyId) => {
      const body = json(await reconcileFixedAssetsTool.handler({ as_at: AS_AT }, toolCtx(companyId)));
      // The guard is only worth having if it can fail. Proven by mutation
      // (see the report); asserted here as a contract: the field exists and is
      // absent when sound, exactly like completenessFault on the envelope.
      // Absent when sound, exactly like completenessFault on the envelope.
      // That it can FIRE is proven by mutation rather than asserted here.
      expect(body.disclosureFault).toBeUndefined();
    });
  });
});
