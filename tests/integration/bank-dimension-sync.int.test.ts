/**
 * Bank rows mirror their allocation journal's CC1 / CC2 / BU (PR #698 round 2),
 * against a real database: bank rows allocated by the real allocate / split
 * tools (VAT line and all), then synced by tag_journal_lines (write-through) and
 * sync_bank_dimensions (back-fill), and read back through the Banking list.
 *
 * Mirror semantics (Hein): a bank row's tags equal its journal's agreed set,
 * NULLs included, so a CC1-only journal blanks the row's CC2 / BU and the dry run
 * says so. The agreed set is taken over EVERY non-bank, non-control line.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { ALL_RAW_SUBTYPES } from '../../src/modules/accounting/services/gl/accountSubtypes';
import { isControlSubtype } from '../../src/modules/accounting/services/gl/dimensions/dimensionPolicy';
import { isControlSubtypeSql } from '../../src/modules/accounting/services/gl/dimensions/journalDimensionSetSql';
import {
  allocate, bankDims, cleanupSync, displayOf, json, lineOn, linesOf, mcpAs, newKey, setBankDims, setJournalStatus,
  setLineDims, splitAllocate, supplierPayment, syncFixture, type SyncFixture,
} from './bank-dimension-sync.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const users: string[] = [];
const tokens: Record<string, string> = {};
const mcp = mcpAs(pool);
afterAll(() => cleanupSync(pool, companies, users));

const WINDOW = { date_from: '2026-01-01', date_to: '2026-12-31' };
async function fresh(): Promise<SyncFixture> {
  const f = await syncFixture(pool, tokens, companies);
  users.push(f.user);
  return f;
}
const code = (f: SyncFixture, k: string) => `${k}${f.c.slice(0, 6)}`;
const sync = (f: SyncFixture, dry: boolean, extra: Record<string, unknown> = {}) =>
  mcp(f.user, f.c, 'sync_bank_dimensions', { ...WINDOW, dry_run: dry, idempotency_key: newKey('sync'), ...extra });
const tag = (f: SyncFixture, lines: Record<string, unknown>[]) =>
  mcp(f.user, f.c, 'tag_journal_lines', { lines, idempotency_key: newKey('tag') });

describe('an agreed set is copied onto the bank row', () => {
  it('a journal tagged on one expense line: dry run counts it, the live call writes it, the list then shows the row\'s own', async () => {
    const f = await fresh();
    const { tx } = await allocate(pool, f, { cc2: code(f, 'P1'), bu: code(f, 'B1') });
    expect(await bankDims(pool, tx)).toEqual({ cc1: null, cc2: null, bu: null });
    expect(await displayOf(pool, f, tx)).toMatchObject({ source: 'journal', cc2: code(f, 'P1'), bu: code(f, 'B1') });

    const dry = json<{ would_sync: number; would_blank: unknown[] }>(await sync(f, true));
    expect(dry.would_sync).toBe(1);
    expect(dry.would_blank).toEqual([]);
    expect(await bankDims(pool, tx)).toEqual({ cc1: null, cc2: null, bu: null });

    const live = json<{ batch_id: string; bank_rows_synced: number }>(await sync(f, false));
    expect(live.bank_rows_synced).toBe(1);
    expect(await bankDims(pool, tx)).toEqual({ cc1: f.cc.F1, cc2: f.cc.P1, bu: f.bu.B1 });
    expect(await displayOf(pool, f, tx)).toMatchObject({ source: 'bank', cc1: code(f, 'F1'), cc2: code(f, 'P1') });
  });

  it('a VAT-bearing allocation to ONE expense is one agreed set (the VAT and bank legs are not dimension lines)', async () => {
    const f = await fresh();
    const { tx, journal } = await allocate(pool, f, { vat: 'standard', cc2: code(f, 'P2') });
    expect((await linesOf(pool, journal)).map((l) => l.subtype ?? 'expense').sort()).toEqual(['bank', 'expense', 'vat_input']);
    expect(await displayOf(pool, f, tx)).toMatchObject({ source: 'journal', cc2: code(f, 'P2') });
    expect(json<{ would_sync: number }>(await sync(f, true)).would_sync).toBe(1);
    await sync(f, false);
    expect(await bankDims(pool, tx)).toEqual({ cc1: f.cc.F2, cc2: f.cc.P2, bu: null });
  });
});

describe('a journal that does not agree is left alone and shown as Split', () => {
  it('two expense lines in two projects', async () => {
    const f = await fresh();
    const { tx } = await splitAllocate(pool, f, [
      { account: f.expA, amount: 600, cc2: code(f, 'P1') }, { account: f.expC, amount: 400, cc2: code(f, 'P2') }]);
    expect(await displayOf(pool, f, tx)).toMatchObject({ source: 'split' });
    expect(json<{ would_sync: number }>(await sync(f, true)).would_sync).toBe(0);
    expect(json<{ bank_rows_synced: number }>(await sync(f, false)).bank_rows_synced).toBe(0);
    expect(await bankDims(pool, tx)).toEqual({ cc1: null, cc2: null, bu: null });
  });

  it('one tagged expense line and one untagged: a partial tagging is a split, not the tagged set for the whole amount (REPRO 3)', async () => {
    const f = await fresh();
    const { tx } = await splitAllocate(pool, f, [{ account: f.expA, amount: 600, cc2: code(f, 'P1') }, { account: f.expC, amount: 400 }]);
    expect(await displayOf(pool, f, tx)).toMatchObject({ source: 'split' });
    expect(json<{ would_sync: number }>(await sync(f, true)).would_sync).toBe(0);
    await sync(f, false);
    expect(await bankDims(pool, tx)).toEqual({ cc1: null, cc2: null, bu: null });
  });
});

describe('mirror semantics: NULLs are copied too', () => {
  it('a CC1-only journal blanks the row\'s CC2 and BU, and the dry run lists exactly those blanks', async () => {
    const f = await fresh();
    const { tx } = await allocate(pool, f, { cc1: code(f, 'F1') });
    await setBankDims(pool, tx, { cc1: f.cc.F1, cc2: f.cc.P1, bu: f.bu.B1 });

    const dry = json<{ would_sync: number; would_blank: { bank_transaction_id: string; blanks: string[]; old: object; new: object }[] }>(await sync(f, true));
    expect(dry.would_sync).toBe(1);
    expect(dry.would_blank).toHaveLength(1);
    expect(dry.would_blank[0]).toMatchObject({
      bank_transaction_id: tx, blanks: ['cc2', 'bu'],
      old: { cc1_id: f.cc.F1, cc2_id: f.cc.P1, bu_id: f.bu.B1 }, new: { cc1_id: f.cc.F1, cc2_id: null, bu_id: null },
    });
    expect(await bankDims(pool, tx)).toEqual({ cc1: f.cc.F1, cc2: f.cc.P1, bu: f.bu.B1 });

    await sync(f, false);
    expect(await bankDims(pool, tx)).toEqual({ cc1: f.cc.F1, cc2: null, bu: null });
  });

  it('a change that blanks nothing (a row with no tags) is not listed as a blank', async () => {
    const f = await fresh();
    await allocate(pool, f, { cc2: code(f, 'P1') });
    expect(json<{ would_blank: unknown[] }>(await sync(f, true)).would_blank).toEqual([]);
  });
});

describe('a journal whose tags were all removed clears the bank row (REPRO 1)', () => {
  it('tag_journal_lines clearing the only tagged line writes NULLs through, and reversing the batch puts the tags back', async () => {
    const f = await fresh();
    const { tx, journal } = await allocate(pool, f, { cc2: code(f, 'P1'), bu: code(f, 'B1') });
    await sync(f, false);
    expect(await bankDims(pool, tx)).toEqual({ cc1: f.cc.F1, cc2: f.cc.P1, bu: f.bu.B1 });

    const line = await lineOn(pool, journal, f.expA);
    const cleared = json<{ batch_id: string; bank_rows_synced: number }>(
      await tag(f, [{ journal_line_id: line.id, cc1: null, cc2: null, bu: null }]));
    expect(cleared.bank_rows_synced).toBe(1);
    expect(await bankDims(pool, tx)).toEqual({ cc1: null, cc2: null, bu: null });
    expect(await displayOf(pool, f, tx)).toMatchObject({ source: undefined });

    const undone = await mcp(f.user, f.c, 'reverse_dimension_tag_batch', { batch_id: cleared.batch_id, idempotency_key: newKey('rev') });
    expect(undone.isError, undone.content[0]!.text).toBeFalsy();
    expect(await bankDims(pool, tx)).toEqual({ cc1: f.cc.F1, cc2: f.cc.P1, bu: f.bu.B1 });
  });

  it('one of two expense lines cleared leaves a partial tagging: the bank row is left as it was', async () => {
    const f = await fresh();
    const { tx, journal } = await splitAllocate(pool, f, [
      { account: f.expA, amount: 600, cc2: code(f, 'P1') }, { account: f.expC, amount: 400, cc2: code(f, 'P1') }]);
    await sync(f, false);
    expect(await bankDims(pool, tx)).toEqual({ cc1: f.cc.F1, cc2: f.cc.P1, bu: null });
    await tag(f, [{ journal_line_id: (await lineOn(pool, journal, f.expC)).id, cc1: null, cc2: null }]);
    expect(await bankDims(pool, tx)).toEqual({ cc1: f.cc.F1, cc2: f.cc.P1, bu: null });
    expect(await displayOf(pool, f, tx)).toMatchObject({ source: 'bank' });
  });
});

describe('the back-fill leaves journals that carry no dimensions alone', () => {
  it('a supplier payment (AP + bank) keeps the bank row\'s own tags', async () => {
    const f = await fresh();
    const { tx } = await supplierPayment(pool, f);
    await setBankDims(pool, tx, { cc1: f.cc.F1, cc2: f.cc.P1 });
    expect(json<{ would_sync: number }>(await sync(f, true)).would_sync).toBe(0);
    await sync(f, false);
    expect(await bankDims(pool, tx)).toEqual({ cc1: f.cc.F1, cc2: f.cc.P1, bu: null });
  });

  it('an untagged expense journal keeps the bank row\'s own tags', async () => {
    const f = await fresh();
    const { tx } = await allocate(pool, f, {});
    await setBankDims(pool, tx, { bu: f.bu.B2 });
    expect(json<{ would_sync: number }>(await sync(f, true)).would_sync).toBe(0);
    expect(await bankDims(pool, tx)).toEqual({ cc1: null, cc2: null, bu: f.bu.B2 });
  });
});

describe('only a posted journal counts', () => {
  it.each(['draft', 'reversed'])('a %s journal is neither synced nor shown', async (status) => {
    const f = await fresh();
    const { tx, journal } = await allocate(pool, f, { cc2: code(f, 'P1') });
    await setJournalStatus(pool, journal, status);
    expect(json<{ would_sync: number }>(await sync(f, true)).would_sync).toBe(0);
    expect((await displayOf(pool, f, tx)).source).toBeUndefined();
    await setJournalStatus(pool, journal, 'posted');
    expect(json<{ would_sync: number }>(await sync(f, true)).would_sync).toBe(1);
  });
});

describe('the write-through only touches the batch\'s own journals', () => {
  it('another journal tagged earlier by hand keeps its stale bank row', async () => {
    const f = await fresh();
    const a = await allocate(pool, f, {});
    const b = await allocate(pool, f, {});
    await setLineDims(pool, (await lineOn(pool, b.journal, f.expA)).id, { cc1: f.cc.F2, cc2: f.cc.P2 });
    const done = json<{ bank_rows_synced: number }>(await tag(f, [
      { journal_line_id: (await lineOn(pool, a.journal, f.expA)).id, cc2: code(f, 'P1') }]));
    expect(done.bank_rows_synced).toBe(1);
    expect(await bankDims(pool, a.tx)).toEqual({ cc1: f.cc.F1, cc2: f.cc.P1, bu: null });
    expect(await bankDims(pool, b.tx)).toEqual({ cc1: null, cc2: null, bu: null });
  });
});

describe('the SQL control-account predicate is isControlSubtype', () => {
  it('agrees on every raw subtype in the vocabulary and on the spellings canonicalSubtype normalises', async () => {
    const spellings = [...ALL_RAW_SUBTYPES, 'Vat Input', '  BANK ', 'payroll-liability', 'Credit Card', 'VAT  output', '', 'expense', 'nonsense'];
    const wrong: string[] = [];
    for (const raw of spellings) {
      const sqlSays = (await pool.query(`SELECT ${isControlSubtypeSql('$1::TEXT')} AS c`, [raw])).rows[0].c as boolean;
      if (sqlSays !== isControlSubtype(raw)) wrong.push(raw);
    }
    expect((await pool.query(`SELECT ${isControlSubtypeSql('NULL::TEXT')} AS c`)).rows[0].c).toBe(false);
    expect(wrong).toEqual([]);
  });
});
