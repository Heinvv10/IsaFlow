/**
 * A cost centre or business unit that only an un-reversed sync batch's OLD bank-row
 * values name cannot be deleted or moved: reversing the batch would restore the id
 * onto the bank row (PR #698 follow-up). Against a real database; the bank row now
 * carries the journal's set, so the batch's old_* columns are the only reference.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asToken } from './bank-controls-a.helpers';
import { allocate, cleanupSync, json, mcpAs, newKey, setBankDims, syncFixture, type SyncFixture } from './bank-dimension-sync.helpers';
import { assertCostCentreUnused, countCc2Carriers } from '../../src/modules/accounting/services/core/costCentreUsageGuard';
import { assertBusinessUnitUnused } from '../../src/modules/accounting/services/core/businessUnitService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const users: string[] = [];
const tokens: Record<string, string> = {};
const mcp = mcpAs(pool);
afterAll(() => cleanupSync(pool, companies, users));

const code = (f: SyncFixture, k: string) => `${k}${f.c.slice(0, 6)}`;

/** A bank row holding (F3, P1, B1) whose journal is CC1-only F1: the sync replaces F3 and blanks P1 and B1. */
async function syncedAway(): Promise<{ f: SyncFixture; f3: string; batch: string }> {
  const f = await syncFixture(pool, tokens, companies);
  users.push(f.user);
  const f3 = crypto.randomUUID();
  await pool.query("INSERT INTO cost_centres(id, company_id, code, name, cc_type) VALUES ($1,$2,$3,'Centre F3','cc1')", [f3, f.c, code(f, 'F3')]);
  const { tx } = await allocate(pool, f, { cc1: code(f, 'F1') });
  await setBankDims(pool, tx, { cc1: f3, cc2: f.cc.P1, bu: f.bu.B1 });
  const done = json<{ batch_id: string }>(await mcp(f.user, f.c, 'sync_bank_dimensions', {
    date_from: '2026-01-01', date_to: '2026-12-31', idempotency_key: newKey('dg') }));
  return { f, f3, batch: done.batch_id };
}
const inTx = <T>(f: SyncFixture, fn: () => Promise<T>) => asToken(pool, f.user, f.c, fn);

describe('an un-reversed sync batch holds the ids its bank rows had', () => {
  it.each([
    ['CC2 (old_cc2_id)', (f: SyncFixture) => f.cc.P1, 'cc'],
    ['CC1 (old_cc1_id)', (_f: SyncFixture, f3: string) => f3, 'cc'],
    ['BU (old_bu_id)', (f: SyncFixture) => f.bu.B1, 'bu'],
  ] as const)('the %s only the batch names cannot be deleted', async (_label, pick, kind) => {
    const { f, f3 } = await syncedAway();
    const id = pick(f, f3);
    const check = kind === 'bu' ? assertBusinessUnitUnused : assertCostCentreUnused;
    await expect(inTx(f, () => check(f.c, id))).rejects.toThrow(/1 un-reversed tag batch bank row\(s\)/);
  });

  it('a CC2 only the batch names still counts as a carrier, so it cannot move to another FNO', async () => {
    const { f } = await syncedAway();
    expect(await inTx(f, () => countCc2Carriers(f.c, [f.cc.P1]))).toBe(1);
  });

  it('once the batch is reversed it no longer holds them (the restored bank row does, by its own columns)', async () => {
    const { f, batch } = await syncedAway();
    const res = await mcp(f.user, f.c, 'reverse_dimension_tag_batch', { batch_id: batch, idempotency_key: newKey('dg-rev') });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    await expect(inTx(f, () => assertCostCentreUnused(f.c, f.cc.P1))).rejects.toThrow(/1 bank transaction\(s\)/);
    await expect(inTx(f, () => assertCostCentreUnused(f.c, f.cc.P1))).rejects.not.toThrow(/un-reversed tag batch bank row/);
  });

  it('another company\'s batch is not counted (the query scopes by company itself: run as the superuser, outside RLS)', async () => {
    const { f } = await syncedAway();
    const { f: g } = await syncedAway();
    await expect(assertCostCentreUnused(f.c, f.cc.P1)).rejects.toThrow(/un-reversed tag batch bank row/);
    await expect(assertCostCentreUnused(g.c, f.cc.P1)).resolves.toBeUndefined();
    await expect(assertBusinessUnitUnused(g.c, f.bu.B1)).resolves.toBeUndefined();
  });
});
