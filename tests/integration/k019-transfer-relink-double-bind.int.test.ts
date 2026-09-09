// K-019: relinkTransferCounterparts bound one journal line to two bank
// transactions. `best_matches` de-duplicated with DISTINCT ON (bt_new.id) —
// per new transaction only — nothing excluded a line a bank transaction had
// already claimed, and the swallowing catch had no savepoint.
// Source: src/modules/accounting/services/bank/bankTransferLinkService.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { getPoolForTests } from '@/lib/neon';
import { relinkTransferCounterparts } from '@/modules/accounting/services/bank/bankTransferLinkService';
import {
  AMOUNT, DAY, addAccount, addSecondLegToJournal, cleanup, rowsOn, seedScenario,
} from './helpers/k019TransferFixture';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const user = crypto.randomUUID();

type Ctx = Parameters<typeof als.run>[0];
const ctxFor = (client: PoolClient, companyId: string): Ctx =>
  ({ client, userId: user, companyId, claims: {} }) as unknown as Ctx;

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [
    company, 'K019 relink fixture', other, 'K019 other tenant',
  ]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
});

afterAll(async () => {
  try {
    await cleanup(pool, [company, other], user);
  } finally {
    await pool.end();
  }
});

describe('K-019 relinkTransferCounterparts', () => {
  it('binds one bank line per GL movement and leaves the runner-up imported', async () => {
    const s = await seedScenario(pool, company, user, 1, 2);

    const { linked, failed } = await relinkTransferCounterparts(company, s.targetBank);
    expect(failed).toBe(false);
    expect(linked).toBe(1);

    const rows = await rowsOn(pool, company, s.targetBank);
    const claimed = rows.filter((r) => r.matched_journal_line_id !== null);
    expect(claimed).toHaveLength(1);
    expect(new Set(claimed.map((r) => r.matched_journal_line_id)).size).toBe(1);
    expect(claimed[0].matched_journal_line_id).toBe(s.freeLines[0]);
    expect(claimed[0].status).toBe('allocated');
    expect(claimed[0].counterparty_account_id).toBe(s.sourceBanks[0]);
    // LOW-2: the duplicate-transfer guard selects on this column, so a relinked
    // row without it lets a second transfer journal be posted for the movement.
    expect(claimed[0].transfer_journal_entry_id).toBe(s.journals[0]);

    const untouched = rows.filter((r) => r.matched_journal_line_id === null);
    expect(untouched).toHaveLength(1);
    expect(untouched[0].status).toBe('imported');
  });

  it('links BOTH legs in one call when two free lines exist', async () => {
    const s = await seedScenario(pool, company, user, 2, 2);

    const { linked } = await relinkTransferCounterparts(company, s.targetBank);
    expect(linked).toBe(2);

    const rows = await rowsOn(pool, company, s.targetBank);
    const claimed = rows.filter((r) => r.matched_journal_line_id !== null);
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((r) => r.matched_journal_line_id)).size).toBe(2);
    expect([...claimed.map((r) => r.matched_journal_line_id)].sort())
      .toEqual([...s.freeLines].sort());
  });

  it('offers both legs of a journal that moves this bank twice', async () => {
    const s = await seedScenario(pool, company, user, 1, 2);
    const secondLeg = await addSecondLegToJournal(pool, company, s.journals[0], s.targetBank);

    const { linked } = await relinkTransferCounterparts(company, s.targetBank);
    expect(linked).toBe(2);

    const rows = await rowsOn(pool, company, s.targetBank);
    const claimed = rows.filter((r) => r.matched_journal_line_id !== null);
    expect(new Set(claimed.map((r) => r.matched_journal_line_id)))
      .toEqual(new Set([s.freeLines[0], secondLeg]));
  });

  it('picks the lowest free leg first when a journal moves this bank twice', async () => {
    // source_allocs is a DISTINCT ON. Without its ORDER BY, PostgreSQL takes an
    // arbitrary row — heap order, which is insertion order here. The higher id
    // is inserted FIRST, so heap order and id order disagree and the assertion
    // below distinguishes them.
    const s = await seedScenario(pool, company, user, 1, 1);
    const [low, high] = [crypto.randomUUID(), crypto.randomUUID()].sort();
    await pool.query('DELETE FROM gl_journal_lines WHERE id=$1', [s.freeLines[0]]);
    for (const id of [high, low]) {
      await pool.query(
        `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
         VALUES($1,$2,$3,$4,${AMOUNT},0)`,
        [id, company, s.journals[0], s.targetBank],
      );
    }

    const { linked } = await relinkTransferCounterparts(company, s.targetBank);
    expect(linked).toBe(1);

    const claimed = (await rowsOn(pool, company, s.targetBank))
      .filter((r) => r.matched_journal_line_id !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].matched_journal_line_id).toBe(low);
  });

  it('links five contending rows in a SINGLE statement, not one per pass', async () => {
    // Five rows and five equally close free lines rank 1..5 identically on both
    // axes, so tx_rank = line_rank pairs them all in one pass. Before the rank
    // join every row was handed the same lowest line and the pass linked one.
    const s = await seedScenario(pool, company, user, 5, 5);

    const client = await getPoolForTests().connect();
    const updates: string[] = [];
    const recording = new Proxy(client, {
      get(target, prop) {
        if (prop !== 'query') return Reflect.get(target, prop);
        return (text: unknown, params?: unknown) => {
          const sqlText = typeof text === 'string' ? text : String((text as { text?: string })?.text ?? '');
          if (/UPDATE bank_transactions/i.test(sqlText)) updates.push(sqlText);
          return (target.query as (t: unknown, p?: unknown) => unknown)(text, params);
        };
      },
    }) as PoolClient;

    try {
      await client.query('BEGIN');
      const { linked, passes } = await als.run(ctxFor(recording, company), () =>
        relinkTransferCounterparts(company, s.targetBank),
      );
      expect(linked).toBe(5);
      expect(passes).toBe(1);
      // One linking statement; the second is the pass that finds nothing.
      expect(updates).toHaveLength(2);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const claimed = (await rowsOn(pool, company, s.targetBank))
      .filter((r) => r.matched_journal_line_id !== null);
    expect(claimed).toHaveLength(5);
    expect(new Set(claimed.map((r) => r.matched_journal_line_id)).size).toBe(5);
  });

  it('keeps two rows off one line when the diagonal alone would let both through', async () => {
    // The rank diagonal is not by itself a matching. Two sources four days
    // apart, and a middle row two days from each: the middle row is rank 2 on
    // its chosen line AND rank 2 in that line's own order, so it survives the
    // diagonal and lands on a line the closer row has already won. Only the
    // per-line stage stops the double-bind.
    const targetBank = await addAccount(pool, company);
    const [lineNear, lineFar] = [crypto.randomUUID(), crypto.randomUUID()].sort();
    const built = [
      { line: lineNear, day: 0 },
      { line: lineFar, day: 4 },
    ];
    for (const b of built) {
      const srcBank = await addAccount(pool, company);
      const je = crypto.randomUUID();
      const srcLine = crypto.randomUUID();
      await pool.query(
        `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,status,created_by)
         VALUES($1,$2,DATE '${DAY}' + $3::int,'K019 diag','posted',$4)`,
        [je, company, b.day, user],
      );
      await pool.query(
        `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
         VALUES($1,$3,$4,$5,0,${AMOUNT}),($2,$3,$4,$6,${AMOUNT},0)`,
        [srcLine, b.line, company, je, srcBank, targetBank],
      );
      await pool.query(
        `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,matched_journal_line_id,transfer_journal_entry_id,allocation_type)
         VALUES($1,$2,$3,DATE '${DAY}' + $4::int,${-AMOUNT},'K019 diag out','allocated',$5,$6,'transfer')`,
        [crypto.randomUUID(), company, srcBank, b.day, srcLine, je],
      );
    }
    // Exact matches for each line, plus one row equidistant from both.
    for (const [day, label] of [[0, 'near'], [4, 'far'], [2, 'middle']] as const) {
      await pool.query(
        `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
         VALUES($1,$2,$3,DATE '${DAY}' + $4::int,${AMOUNT},$5,'imported')`,
        [crypto.randomUUID(), company, targetBank, day, `K019 diag in ${label}`],
      );
    }

    const { linked } = await relinkTransferCounterparts(company, targetBank);
    expect(linked).toBe(2);

    const rows = await rowsOn(pool, company, targetBank);
    const claimed = rows.filter((r) => r.matched_journal_line_id !== null);
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((r) => r.matched_journal_line_id)))
      .toEqual(new Set([lineNear, lineFar]));
    expect(rows.filter((r) => r.status === 'imported')).toHaveLength(1);
  });

  it('is idempotent: a second pass claims nothing already claimed', async () => {
    const s = await seedScenario(pool, company, user, 1, 2);
    expect((await relinkTransferCounterparts(company, s.targetBank)).linked).toBe(1);

    const before = await rowsOn(pool, company, s.targetBank);
    const { linked } = await relinkTransferCounterparts(company, s.targetBank);
    const after = await rowsOn(pool, company, s.targetBank);

    expect(linked).toBe(0);
    expect(after.map((r) => r.matched_journal_line_id)).toEqual(before.map((r) => r.matched_journal_line_id));
  });

  it('never sources a counterpart from another company, even on this bank account', async () => {
    // Our own bank account, but the only candidate journal and its allocated
    // outgoing leg belong to the OTHER tenant. Dropping either company_id
    // predicate in source_allocs makes this link.
    const s = await seedScenario(pool, company, user, 0, 1);
    const theirBank = crypto.randomUUID();
    const theirJe = crypto.randomUUID();
    const theirSrcLine = crypto.randomUUID();
    const theirTargetLine = crypto.randomUUID();
    const theirTx = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance)
       VALUES($1,$2,'K19OTH','K019 their bank','asset','debit')`,
      [theirBank, other],
    );
    await pool.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,status,created_by)
       VALUES($1,$2,DATE '${DAY}','K019 their transfer','posted',$3)`,
      [theirJe, other, user],
    );
    // Their journal carries a leg on OUR target bank account.
    await pool.query(
      `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
       VALUES($1,$3,$4,$5,0,${AMOUNT}),($2,$3,$4,$6,${AMOUNT},0)`,
      [theirSrcLine, theirTargetLine, other, theirJe, theirBank, s.targetBank],
    );
    await pool.query(
      `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,matched_journal_line_id,transfer_journal_entry_id,allocation_type)
       VALUES($1,$2,$3,DATE '${DAY}',${-AMOUNT},'K019 their out','allocated',$4,$5,'transfer')`,
      [theirTx, other, theirBank, theirSrcLine, theirJe],
    );

    const { linked } = await relinkTransferCounterparts(company, s.targetBank);
    expect(linked).toBe(0);

    const rows = await rowsOn(pool, company, s.targetBank);
    expect(rows.every((r) => r.matched_journal_line_id === null)).toBe(true);
    expect(rows.every((r) => r.status === 'imported')).toBe(true);
  });

  it('does not treat another company claim on our line as consuming it', async () => {
    // The anti-join must be company-scoped: a foreign row referencing our line
    // is not a claim we may honour, or one tenant can freeze another's relink.
    const s = await seedScenario(pool, company, user, 1, 1);
    await pool.query(
      `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,matched_journal_line_id,allocation_type)
       VALUES($1,$2,$3,DATE '${DAY}',${AMOUNT},'K019 foreign claim','allocated',$4,'transfer')`,
      [crypto.randomUUID(), other, s.targetBank, s.freeLines[0]],
    );

    const { linked } = await relinkTransferCounterparts(company, s.targetBank);
    expect(linked).toBe(1);

    const claimed = (await rowsOn(pool, company, s.targetBank))
      .filter((r) => r.matched_journal_line_id !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].matched_journal_line_id).toBe(s.freeLines[0]);
  });

  it('a failure inside the relink does not poison the request transaction', async () => {
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      // A non-UUID bank account makes the ::UUID cast fail (22P02) inside the
      // service. Without its own savepoint the whole request tx aborts.
      const result = await als.run(ctxFor(client, company), () =>
        relinkTransferCounterparts(company, 'not-a-uuid'),
      );
      expect(result).toEqual({ linked: 0, passes: 0, failed: true });

      // The transaction is still usable: this would raise 25P02 otherwise.
      const res = await client.query('SELECT 1 AS ok');
      expect(res.rows[0].ok).toBe(1);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });
});
