/**
 * DOCNUM: two documents numbered at the same moment for one scope and year no longer share a number.
 *
 * Eight BEFORE INSERT triggers (credit notes, customer and supplier payments, consolidation adjustments,
 * accounting adjustments, supplier payment batches, VAT adjustments, write-offs) mint `<P>-<year>-<seq>` as
 * MAX(seq)+1 over the scope's COMMITTED numbers with nothing serialising two writers — the shape migration 857
 * fixed for journals. Before migration 858 a second writer read the same MAX as an uncommitted first one and
 * minted the same number: on the four tables without a unique index on the number the duplicate was stored
 * silently; on the four with one it waited on the index and failed 23505. 858 takes an advisory lock on
 * (scope, year) before the MAX — for the seven company-scoped functions the journal-number lock of 857 itself,
 * `hashtextextended('<company>:<year>', 857)`, so numbering a document and a journal in either order cannot
 * deadlock on two number locks; for consolidation adjustments `hashtextextended('<group>:<year>', 858)` — so the second writer waits
 * for the first to commit and mints the next number.
 *
 * Each case inserts straight into its table on dedicated connections: A inserts and holds its transaction open,
 * B inserts for the same scope. Holder and waiter are matched by pid (the fixture database is shared). Fresh
 * random companies per run, so concurrent runs of this file never share a numbering scope.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import {
  CASES, blockedBeforeSettling, dropScope, errText, insertDoc, insertJournal, nextNumber, pidOf, seedScope, settle,
  type Scope,
} from './helpers/docnumFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
// ci-integration-skip: consolidation adjustments number under their GROUP key ('<group>:<year>', 858), not the journal's company key, so the document-then-journal (same company + year) deadlock case does not apply to them.

/** Every trigger reads the year from the row's own date (858 moved ADJ/BAT/VA/WO off CURRENT_DATE). */
const ROW_YEAR = 2031;

let admin: Client, holder: Client, waiter: Client;
let holderPid = 0, waiterPid = 0;
let s1: Scope | undefined, s2: Scope | undefined;

describeIfDb('DOCNUM: document numbering under concurrent inserts', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    [admin, holder, waiter] = [0, 1, 2].map(() => new Client({ connectionString: DATABASE_URL }));
    for (const c of [admin, holder, waiter]) await c.connect();
    holderPid = await pidOf(holder);
    waiterPid = await pidOf(waiter);
    s1 = await seedScope(admin, 'DOCNUM-1');
    s2 = await seedScope(admin, 'DOCNUM-2');
  }, 60000);

  afterAll(async () => {
    try {
      for (const s of [s1, s2]) if (s) await dropScope(admin, s);
    } finally {
      for (const c of [admin, holder, waiter]) await c?.end();
    }
  }, 60000);

  /** Runs `body` with `holder` inside an open transaction; always ends it. */
  async function holding(body: () => Promise<void>): Promise<void> {
    await holder.query('BEGIN');
    try {
      await body();
    } finally {
      // After a COMMIT inside `body` this is a no-op (a WARNING, not an error).
      await holder.query('ROLLBACK');
    }
  }

  describe.each(CASES)('$fn ($table)', (k) => {
    // The trigger's lock must be EXACTLY this key: the journal key of 857 (company-scoped) or the group key of 858.
    // A key off by its scope, year, separator or seed would still serialise two inserts of this table and pass
    // every other test here, while missing the journal lock it has to share (docnum-journal-order).
    it('waits on exactly hashtextextended(<scope>:<year>, seed)', async () => {
      await holding(async () => {
        await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, $2))',
          [`${k.scopeOf(s1!)}:${ROW_YEAR}`, k.seed]);
        const pB = settle(insertDoc(waiter, k, s1!, ROW_YEAR));
        expect(await blockedBeforeSettling(admin, holderPid, waiterPid, pB), 'the insert must wait on that key')
          .toBe(true);
        await holder.query('ROLLBACK');
        const out = await pB;
        expect(out.ok, out.ok ? '' : errText(out.error)).toBe(true);
      });
    }, 60000);

    it('same scope + year: the second writer waits for the first, then gets the next number', async () => {
      await holding(async () => {
        const nA = await insertDoc(holder, k, s1!, ROW_YEAR);
        const pB = settle(insertDoc(waiter, k, s1!, ROW_YEAR));
        const waited = await blockedBeforeSettling(admin, holderPid, waiterPid, pB);
        await holder.query('COMMIT');
        const out = await pB;
        expect(out.ok, out.ok ? '' : `B failed: ${errText(out.error)}`).toBe(true);
        expect(out.ok && out.value, `B must not reuse A's ${nA}`).toBe(nextNumber(nA));
        expect(waited, 'B must wait for A to commit').toBe(true);
      });
    }, 60000);

    it('a different scope, same year: no wait', async () => {
      await holding(async () => {
        await insertDoc(holder, k, s1!, ROW_YEAR);
        const pB = settle(insertDoc(waiter, k, s2!, ROW_YEAR));
        // Asserted before awaiting B: a B that waits would otherwise wait on the open holder for ever.
        expect(await blockedBeforeSettling(admin, holderPid, waiterPid, pB),
          "another scope's insert must not wait on this one").toBe(false);
        const out = await pB;
        expect(out.ok, out.ok ? '' : errText(out.error)).toBe(true);
      });
    }, 60000);

    it('same scope, a different year: no wait', async () => {
      await holding(async () => {
        await insertDoc(holder, k, s1!, ROW_YEAR);
        const pB = settle(insertDoc(waiter, k, s1!, ROW_YEAR + 1));
        expect(await blockedBeforeSettling(admin, holderPid, waiterPid, pB),
          "another year's insert must not wait on this one").toBe(false);
        const out = await pB;
        expect(out.ok && out.value, out.ok ? '' : errText(out.error)).toBe(`${k.prefix}-${ROW_YEAR + 1}-00001`);
      });
    }, 60000);

    // allocateTransaction numbers a journal and THEN a receipt/payment; the gateway receipt and the MCP contra
    // number the payment and THEN its journal. With a lock per document type that pair deadlocked (40P01); 858
    // gives the company-scoped documents the journal's own key, so the second transaction just queues.
    it.skipIf(k.table === 'consolidation_adjustments')(
      'a document then a journal against a journal then a document (same company + year): no deadlock',
      async () => {
        const y = ROW_YEAR;
        await holding(async () => {
          const nA = await insertDoc(holder, k, s1!, y);
          const pB = settle((async () => {
            await waiter.query('BEGIN');
            try {
              await insertJournal(waiter, s1!, y);
              const n = await insertDoc(waiter, k, s1!, y);
              await waiter.query('COMMIT');
              return n;
            } catch (err) {
              await waiter.query('ROLLBACK');
              throw err;
            }
          })());
          await blockedBeforeSettling(admin, holderPid, waiterPid, pB);
          const journal = await settle(insertJournal(holder, s1!, y));
          await holder.query('COMMIT');
          const out = await pB;
          expect(journal.ok, journal.ok ? '' : `A's journal failed: ${errText(journal.error)}`).toBe(true);
          expect(out.ok, out.ok ? '' : `B failed: ${errText(out.error)}`).toBe(true);
          expect(out.ok && out.value, `B must not reuse A's ${nA}`).toBe(nextNumber(nA));
        });
      }, 60000);

    it('past 99999 the number keeps all its digits: 100000, then 100001', async () => {
      const y = ROW_YEAR;
      await insertDoc(admin, k, s2!, y, `${k.prefix}-${y}-99999`);
      expect(await insertDoc(admin, k, s2!, y)).toBe(`${k.prefix}-${y}-100000`);
      // The MAX must read 100000 (6 digits) above 99999 (5), or this mints 100000 again.
      expect(await insertDoc(admin, k, s2!, y)).toBe(`${k.prefix}-${y}-100001`);
    }, 60000);
  });
});
