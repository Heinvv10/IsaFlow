// bulk_allocate_bank_transactions and an R0.00 line (MCP, 2026-11-13). A zero-amount statement line (a fee waiver, a
// bank memo line) is a fact about the DATA, like "already allocated": it has no journal to post, so it is SKIPPED with
// reason 'zero_amount' and the rest of the batch posts. It used to throw inside allocateTransaction and the registry's
// savepoint rolled the whole batch back. Run through the real registry (idempotency, savepoint, audit) as app_user.
//   • live: good lines post, the zero line is skipped, left 'imported', no journal, batch ids only for the posted ones
//   • dry run: the same skip and would_post; it writes nothing and does NOT consume the idempotency key
//   • idempotency: a replay of a batch that skipped a zero line returns the stored reply and posts nothing twice;
//     a batch whose every line is zero is refused (key stays free)
//   • the zero skip sits among the other skips in the caller's line order
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { bulkAllocateBankTransactionsTool } from '../../src/lib/mcp/tools/writeBankBulkAllocate';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { bankCompany, cleanupBankControlsA, lineStatus, mcpCaller, plantLine, type BankCompany } from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';
const mcp = mcpCaller(pool, [bulkAllocateBankTransactionsTool]);
let seq = 0;
const key = () => `zero-amt-${Date.now()}-${seq++}`;

interface Skip { index: number; transaction_id: string | null; reason: string }
interface Body {
  batch_id: string | null; posted: number; would_post?: number; dry_run?: boolean;
  journal_entry_ids: string[]; lines: Array<{ transaction_id: string }>; skipped: Skip[];
}
const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text) as Body;

beforeAll(async () => { user = await createUser(pool, tokens); });
afterAll(() => cleanupBankControlsA(pool, companies, [user]));

const fixture = () => bankCompany(pool, [[user, 'admin']], companies);
const journals = async (c: string) =>
  (await pool.query('SELECT count(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1', [c])).rows[0].n as number;
const acct = (f: BankCompany, id: string) => ({ transaction_id: id, alloc_type: 'account', contra_account_id: f.expA });

describe('bulk_allocate_bank_transactions: a zero-amount line is skipped, not fatal', () => {
  it('posts the rest, reports the zero line, leaves it untouched', async () => {
    const f = await fixture();
    const [good1, zero, good2] = [await plantLine(pool, f, null, -1500), await plantLine(pool, f, null, 0), await plantLine(pool, f, null, -700)];
    const res = await mcp(user, f.c, 'bulk_allocate_bank_transactions',
      { allocations: [acct(f, good1), acct(f, zero), acct(f, good2)], idempotency_key: key() });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    const body = parse(res);
    expect(body.posted).toBe(2);
    expect(body.skipped).toEqual([{ index: 1, transaction_id: zero, reason: 'zero_amount' }]);
    expect(body.lines.map((l) => l.transaction_id).sort()).toEqual([good1, good2].sort());
    expect(body.batch_id).toBeTruthy();
    expect(await Promise.all([good1, zero, good2].map((id) => lineStatus(pool, id)))).toEqual(['allocated', 'imported', 'allocated']);
    expect(await journals(f.c)).toBe(2);
  });

  it('skips a zero line on every arm (account, supplier, customer), by selector too', async () => {
    const f = await fixture();
    const [good, z1, z2, z3] = [await plantLine(pool, f, null, -900), await plantLine(pool, f, null, 0),
      await plantLine(pool, f, null, 0), await plantLine(pool, f, null, 0)];
    await pool.query("UPDATE bank_transactions SET bank_reference = 'ZERO-REF-1' WHERE id = $1", [z3]);
    const res = await mcp(user, f.c, 'bulk_allocate_bank_transactions', {
      allocations: [
        acct(f, good),
        acct(f, z1),
        { transaction_id: z2, alloc_type: 'supplier', entity_id: f.supplier },
        { bank_reference: 'ZERO-REF-1', alloc_type: 'customer', entity_id: f.customer },
      ],
      idempotency_key: key(),
    });
    expect(res.isError, res.content[0]!.text).toBeFalsy();
    const body = parse(res);
    expect(body.posted).toBe(1);
    expect(body.skipped).toEqual([
      { index: 1, transaction_id: z1, reason: 'zero_amount' },
      { index: 2, transaction_id: z2, reason: 'zero_amount' },
      { index: 3, transaction_id: z3, reason: 'zero_amount' },
    ]);
  });

  it('the dry run reports the same skip and would_post, writes nothing and leaves the key free for the live call', async () => {
    const f = await fixture();
    const [good, zero] = [await plantLine(pool, f, null, -1500), await plantLine(pool, f, null, 0)];
    const args = { allocations: [acct(f, zero), acct(f, good)], idempotency_key: key() };
    const dry = parse(await mcp(user, f.c, 'bulk_allocate_bank_transactions', { ...args, dry_run: true }));
    expect(dry.dry_run).toBe(true);
    expect(dry.would_post).toBe(1);
    expect(dry.skipped).toEqual([{ index: 0, transaction_id: zero, reason: 'zero_amount' }]);
    expect(await journals(f.c)).toBe(0);
    // Same key, live: not served the preview, not refused as a reused key.
    const live = await mcp(user, f.c, 'bulk_allocate_bank_transactions', args);
    expect(live.isError, live.content[0]!.text).toBeFalsy();
    const body = parse(live);
    expect(body.dry_run).toBeUndefined();
    expect(body.posted).toBe(1);
    expect(body.skipped).toEqual(dry.skipped);
    expect(await journals(f.c)).toBe(1);
  });

  it('idempotency: replaying the same key returns the stored reply and posts nothing twice', async () => {
    const f = await fixture();
    const [good, zero] = [await plantLine(pool, f, null, -1500), await plantLine(pool, f, null, 0)];
    const args = { allocations: [acct(f, good), acct(f, zero)], idempotency_key: key() };
    const first = parse(await mcp(user, f.c, 'bulk_allocate_bank_transactions', args));
    const replay = parse(await mcp(user, f.c, 'bulk_allocate_bank_transactions', args));
    expect(replay).toEqual(first);
    expect(first.skipped).toEqual([{ index: 1, transaction_id: zero, reason: 'zero_amount' }]);
    expect(await journals(f.c)).toBe(1);
    // The same key with a different list is still refused, skip or no skip.
    const other = await mcp(user, f.c, 'bulk_allocate_bank_transactions', { allocations: [acct(f, zero)], idempotency_key: args.idempotency_key });
    expect(other.isError).toBe(true);
    expect(other.content[0]!.text).toMatch(/idempotency_key was already used for a different request/);
  });

  it('a batch of only zero lines is refused as nothing to post, and the key stays usable', async () => {
    const f = await fixture();
    const [z1, z2] = [await plantLine(pool, f, null, 0), await plantLine(pool, f, null, 0)];
    const k = key();
    const refused = await mcp(user, f.c, 'bulk_allocate_bank_transactions', { allocations: [acct(f, z1), acct(f, z2)], idempotency_key: k });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/nothing to post: all 2 lines skipped.*zero_amount/);
    const good = await plantLine(pool, f, null, -300);
    const retry = await mcp(user, f.c, 'bulk_allocate_bank_transactions', { allocations: [acct(f, z1), acct(f, good)], idempotency_key: k });
    expect(retry.isError, retry.content[0]!.text).toBeFalsy();
    expect(parse(retry).posted).toBe(1);
  });

  it('keeps the zero skip in the caller\'s line order beside other skips', async () => {
    const f = await fixture();
    const [done, zero, good] = [await plantLine(pool, f, null, -100), await plantLine(pool, f, null, 0), await plantLine(pool, f, null, -200)];
    const first = await mcp(user, f.c, 'bulk_allocate_bank_transactions', { allocations: [acct(f, done)], idempotency_key: key() });
    expect(first.isError, first.content[0]!.text).toBeFalsy();
    const body = parse(await mcp(user, f.c, 'bulk_allocate_bank_transactions',
      { allocations: [acct(f, zero), acct(f, done), acct(f, good)], idempotency_key: key() }));
    expect(body.posted).toBe(1);
    expect(body.skipped.map((s) => [s.index, s.reason])).toEqual([[0, 'zero_amount'], [1, 'already allocated']]);
  });
});
