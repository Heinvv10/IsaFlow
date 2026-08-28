/**
 * `parseAllocationLine` — the shared parser behind allocate_bank_transaction
 * and every line of bulk_allocate_bank_transactions.
 *
 * Pure: it validates shape and coerces fields, and must do so BEFORE anything
 * queries. Two properties are load-bearing.
 *
 * 1. Every id is a uuid column. Left unchecked, `'tx-1'` reaches pg as a
 *    `::uuid` cast and raises 22P02 — which safeErrorText correctly refuses to
 *    echo, so the agent sees only the registry's generic failure and cannot
 *    tell which field, let alone which of 500 lines, was wrong. In a batch it
 *    is worse: the ownership check sends ONE array for all lines, so a single
 *    malformed id fails the query for the entire batch. The check itself is the
 *    shared `guardCastableArgs` (PR #266), not a second regex.
 * 2. Ids are trimmed. `''` was already falsy and harmless, but `'  '` is not —
 *    it would reach allocateTransaction as a literal two-space string to match
 *    invoice ids against.
 */
import { describe, it, expect, vi } from 'vitest';

// The module imports services at load time; none of them run in these tests
// (parseAllocationLine touches no I/O), but the imports still have to resolve.
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionLookupService', () => ({
  findBankTransactionsByReference: vi.fn(),
  // Batched resolution (one query per bulk call) — the plural is what the
  // selector resolver actually calls; default to "nothing matched".
  findBankTransactionsByReferences: vi.fn(async () => new Map()),
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  accountsBelongToCompany: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  customersBelongToCompany: vi.fn(),
  suppliersBelongToCompany: vi.fn(),
}));

import { parseAllocationLine } from '@/lib/mcp/tools/allocationLine';

const TX = '0a000000-0000-4000-8000-000000000001';
const ACC = '0b000000-0000-4000-8000-000000000001';
const SUPPLIER = '0c000000-0000-4000-8000-000000000001';
const INVOICE = '0e000000-0000-4000-8000-000000000001';

describe('parseAllocationLine — malformed ids are refused', () => {
  it.each([
    ['transaction_id', { transaction_id: 'tx-1', contra_account_id: ACC }],
    ['contra_account_id', { transaction_id: TX, contra_account_id: 'acc-1' }],
    ['entity_id', { transaction_id: TX, alloc_type: 'supplier', entity_id: 'sup-1' }],
    ['invoice_id', { transaction_id: TX, contra_account_id: ACC, invoice_id: 'inv-1' }],
    ['bank_account_id', { bank_reference: 'REF1', bank_account_id: 'ba-1', contra_account_id: ACC }],
  ])('names %s', (field, entry) => {
    const result = parseAllocationLine(entry);
    expect(typeof result).toBe('string');
    // Wording comes from the shared guardCastableArgs, so a single line and a
    // bulk line refuse identically.
    expect(result as string).toBe(`invalid ${field}`);
  });

  it('rejects a near-miss rather than letting pg decide', () => {
    expect(parseAllocationLine({ transaction_id: '0a000000-0000-4000-8000-00000000000' }))
      .toBe('invalid transaction_id');                                    // 11 in last group
    expect(parseAllocationLine({ transaction_id: '0a000000_0000_4000_8000_000000000001' }))
      .toBe('invalid transaction_id');
  });
});

// Precedence between the two refusals is a contract, not an implementation
// detail: it is what the single tool has always answered (writeBankAllocate.ts
// ran pickTxSelector before guardCastableArgs), and extracting the shared
// parser silently inverted it. A doubly-faulty line must be told about the
// selector first — that is the fault the agent has to fix before the other one
// even means anything.
describe('parseAllocationLine — which fault wins when a line has two', () => {
  it('reports the missing selector, not the malformed contra account', () => {
    // A contra account is meaningless without a transaction to book it to.
    expect(parseAllocationLine({ contra_account_id: 'acc-1' }))
      .toBe('transaction_id or bank_reference is required');
  });

  it('reports the either/not-both ambiguity, not the malformed transaction_id', () => {
    // Told the id is malformed first, an agent fixes the UUID and is refused
    // again for naming both — two round trips for one line.
    expect(parseAllocationLine({ transaction_id: 'tx-1', bank_reference: 'REF1' }))
      .toMatch(/^Provide either transaction_id or bank_reference, not both/);
  });

  it('still reports a malformed id once the selector itself is sound', () => {
    expect(parseAllocationLine({ transaction_id: TX, contra_account_id: 'acc-1' }))
      .toBe('invalid contra_account_id');
  });
});

describe('parseAllocationLine — field coercion', () => {
  it('treats a whitespace-only invoice_id as absent, not as a two-space id', () => {
    const result = parseAllocationLine({ transaction_id: TX, contra_account_id: ACC, invoice_id: '  ' });
    expect(typeof result).not.toBe('string');
    expect((result as { invoiceId?: string }).invoiceId).toBeUndefined();
  });

  it('trims a padded invoice_id rather than passing the padding to the matcher', () => {
    const result = parseAllocationLine({
      transaction_id: TX, contra_account_id: ACC, invoice_id: ` ${INVOICE} `,
    });
    expect((result as { invoiceId?: string }).invoiceId).toBe(INVOICE);
  });

  it('trims the selector and the entity too', () => {
    const result = parseAllocationLine({
      transaction_id: ` ${TX} `, alloc_type: 'supplier', entity_id: ` ${SUPPLIER} `,
    });
    expect(result).toMatchObject({ selector: { txId: TX }, entityId: SUPPLIER });
  });

  it('defaults alloc_type to account and keeps description unchanged', () => {
    // description is free text, not an id — it is NOT trimmed, because the
    // spacing an agent writes ends up on the journal line as typed.
    const result = parseAllocationLine({
      transaction_id: TX, contra_account_id: ACC, description: '  Rent  ',
    });
    expect(result).toMatchObject({ allocType: 'account', description: '  Rent  ' });
  });
});
