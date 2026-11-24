/**
 * P4-E fix round 3: the payer's journal key (1027's cap-lock key on a journal chain ROOT) lives in a LEAF module. (d) It imports neither
 * `shared/journalChainHead` nor `gl/journalEntryReversalClaim`, which both import it (the claim, and the chain-head lock), so there is no
 * import cycle. (MED) It takes the key ONLY for a chain an allocation message of this company stands on (its source journal is the root):
 * a company that sent one allocation message no longer takes a key for every other journal (an invoice cancel holding its journal row and
 * then reversing it deadlocked with a GL reversal taking key, then row).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import { lockPayerJournalKey, PAYER_JOURNAL_KEY_BUSY } from '@/modules/accounting/services/intercompany/payerJournalKey';

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;
const COMPANY = '11111111-1111-4111-8111-111111111111';
const ENTRY = '22222222-2222-4222-8222-222222222222';
const ROOT = '33333333-3333-4333-8333-333333333333';
const text = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');

beforeEach(() => { sqlMock.mockReset(); });

describe('payerJournalKey (leaf)', () => {
  it('imports neither journalChainHead nor journalEntryReversalClaim (no import cycle)', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/modules/accounting/services/intercompany/payerJournalKey.ts'), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((i) => /journalChainHead|journalEntryReversalClaim|allocationUndoGate/.test(i!))).toEqual([]);
  });

  it('no allocation message stands on the chain root: no key, null, ONE query (the walk and the question together)', async () => {
    sqlMock.mockResolvedValueOnce([]);
    expect(await lockPayerJournalKey(COMPANY, ENTRY)).toBeNull();
    expect(sqlMock).toHaveBeenCalledTimes(1);
    const q = text(sqlMock.mock.calls[0]!);
    expect(q).toMatch(/source_journal_entry_id/);
    expect(q).toMatch(/kind = 'allocation'/);
    expect(q).toMatch(/from_company_id/);
    expect(q).not.toMatch(/pg_advisory_xact_lock/);
  });

  it('an allocation message stands on the root: the key of the ROOT is taken, and the root returned', async () => {
    sqlMock.mockResolvedValueOnce([{ root: ROOT, k: '42' }]).mockResolvedValueOnce([]);
    expect(await lockPayerJournalKey(COMPANY, ENTRY)).toBe(ROOT);
    expect(sqlMock).toHaveBeenCalledTimes(2);
    expect(text(sqlMock.mock.calls[1]!)).toMatch(/pg_advisory_xact_lock/);
    expect(sqlMock.mock.calls[1]!.slice(1)).toEqual(['42']);
  });

  it('the busy sentence names what holds the key, not "another reversal"', () => {
    expect(PAYER_JOURNAL_KEY_BUSY(ENTRY)).toMatch(/intercompany payment/);
    expect(PAYER_JOURNAL_KEY_BUSY(ENTRY)).not.toMatch(/is being reversed by another request/);
  });
});
