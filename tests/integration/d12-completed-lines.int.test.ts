/**
 * D12 census rows 1-5: a line write INTO or ON a COMPLETED bank reconciliation is refused with the typed 409 ("is
 * completed — reopen it first") and writes nothing — the account's lines, the session header and the company's
 * journals read back unchanged. On ddc4dd355 each of these answered 200 and changed the signed-off session
 * (auto_match: brk round0-r6 l.6, `matched:2`). The same verbs on an IN-PROGRESS session still work.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bankMatchConfirm from '../../pages/api/accounting/bank-match-confirm';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser } from './d10-helpers';
import {
  call, cleanup, completedInvariant, completedSession, lineOf, matchInto, newBank, routes, seedJournal, seedPair,
  snapshot, startSession, type Route,
} from './d12-helpers';

let c: Ctx;
let token = '';
const REFUSAL = /is completed — reopen it first/;

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('D12: line writes on a completed reconciliation', () => {
  beforeAll(async () => {
    assertNotProductionDb('D12 lines');
    ({ c, token } = await setupWithUser('D12L'));
  }, 120000);
  afterAll(async () => { await cleanup(c); await clearExtras(c); await teardown(c); }, 120000);

  /** The verb answered 409 with the shared wording and nothing moved. */
  async function refusedUnchanged(s: { bank: string; rec: string }, route: Route, body: Record<string, unknown>) {
    const before = await snapshot(c, s.bank, s.rec);
    const out = await call(c, token, route, body);
    expect(out.status, JSON.stringify(out)).toBe(409);
    expect(out.body).toMatch(REFUSAL);
    expect(await snapshot(c, s.bank, s.rec), 'nothing written').toEqual(before);
    expect(await completedInvariant(c, s.bank, s.rec)).toBeNull();
  }

  it('row 1: auto_match into the completed session -> 409, no candidate matched or stamped', async () => {
    const s = await completedSession(c, token, { matched: 1 });
    await seedPair(c, s.bank, 211.11, '2026-06-20');
    await seedPair(c, s.bank, 222.22, '2026-06-21');
    await refusedUnchanged(s, routes.tx, { action: 'auto_match', bankAccountId: s.bank, reconciliationId: s.rec });
  }, 60000);

  it('row 2: match a fresh line INTO the completed session -> 409', async () => {
    const s = await completedSession(c, token, { matched: 1 });
    const p = await seedPair(c, s.bank, 233.33, '2026-06-22');
    await refusedUnchanged(s, routes.tx, { action: 'match', bankTransactionId: p.bt, journalLineId: p.jl, reconciliationId: s.rec });
  }, 60000);

  it('row 3: re-match a RECONCILED line of the session to another journal line (no session named) -> 409', async () => {
    const s = await completedSession(c, token, { matched: 1 });
    const other = await seedJournal(c, s.bank, 100);
    expect((await lineOf(s.matched[0]!.bt)).status).toBe('reconciled');
    await refusedUnchanged(s, routes.tx, { action: 'match', bankTransactionId: s.matched[0]!.bt, journalLineId: other });
  }, 60000);

  it('row 3: bank-match-confirm journal_line arm on a RECONCILED line -> 409', async () => {
    const s = await completedSession(c, token, { matched: 1 });
    const other = await seedJournal(c, s.bank, 100);
    await refusedUnchanged(s, bankMatchConfirm as Route,
      { bankTransactionId: s.matched[0]!.bt, candidateType: 'journal_line', candidateId: other });
  }, 60000);

  it('row 4: unmatch a RECONCILED line -> 409', async () => {
    const s = await completedSession(c, token, { matched: 2 });
    await refusedUnchanged(s, routes.tx, { action: 'unmatch', bankTransactionId: s.matched[1]!.bt });
  }, 60000);

  it('row 5: exclude a RECONCILED line -> 409', async () => {
    const s = await completedSession(c, token, { matched: 2 });
    await refusedUnchanged(s, routes.tx, { action: 'exclude', bankTransactionId: s.matched[0]!.bt, excludeReason: 'd12' });
  }, 60000);

  it('a line on a completed session that is NOT in it (stale stamp, imported) is not refused: exclude proceeds', async () => {
    const s = await completedSession(c, token, { matched: 1, stale: 1 });
    expect(await lineOf(s.stale[0]!)).toMatchObject({ status: 'imported', rec: s.rec });
    const out = await call(c, token, routes.tx, { action: 'exclude', bankTransactionId: s.stale[0]!, excludeReason: 'd12' });
    expect(out.status, JSON.stringify(out)).toBe(200);
    expect((await lineOf(s.stale[0]!)).status).toBe('excluded');
  }, 60000);

  it('no regression: on an IN-PROGRESS session match / auto_match / unmatch / exclude all work', async () => {
    const bank = await newBank(c);
    const a = await seedPair(c, bank, 244.44, '2026-06-03');
    const b = await seedPair(c, bank, 255.55, '2026-06-04');
    const d = await seedPair(c, bank, 266.66, '2026-06-05');
    const rec = await startSession(c, token, bank);
    await matchInto(c, token, rec, a);
    expect(await lineOf(a.bt)).toMatchObject({ status: 'matched', rec });
    const auto = await call(c, token, routes.tx, { action: 'auto_match', bankAccountId: bank, reconciliationId: rec });
    expect(auto.status, JSON.stringify(auto)).toBe(200);
    expect(auto.body).toMatch(/"matched":2/);
    expect(await lineOf(b.bt)).toMatchObject({ status: 'matched', rec });
    const un = await call(c, token, routes.tx, { action: 'unmatch', bankTransactionId: b.bt });
    expect(un.status, JSON.stringify(un)).toBe(200);
    expect((await lineOf(b.bt)).status).toBe('imported');
    const ex = await call(c, token, routes.tx, { action: 'exclude', bankTransactionId: d.bt, excludeReason: 'd12' });
    expect(ex.status, JSON.stringify(ex)).toBe(200);
  }, 60000);
});
