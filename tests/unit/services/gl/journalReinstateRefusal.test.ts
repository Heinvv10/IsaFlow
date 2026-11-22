/**
 * Migration 1018 round 10 (L4): every refusal the reversal link can meet reaches the user in words, never as raw trigger
 * text, and the two a retry can pass come back as the 503 lock-timeout error.
 */
import { describe, expect, it } from 'vitest';
import {
  JournalReinstatesCancelledDocumentError, JournalReversalChainFullError, JournalReversalRefusedError, ledgerLinkRefusal,
} from '@/modules/accounting/services/gl/journalReinstateRefusal';
import { JournalReversalLockTimeoutError } from '@/modules/accounting/services/gl/journalEntryReversalClaim';

const retry = () => new JournalReversalLockTimeoutError('je-1');
const pg = (o: Record<string, unknown>) => Object.assign(new Error(String(o.message ?? 'x')), o);

describe('ledgerLinkRefusal (migration 1018 round 10)', () => {
  it('maps the named refusals to their typed errors', () => {
    expect(ledgerLinkRefusal(pg({ code: '23514', constraint: 'gl_je_reinstates_cancelled_document' }), 'JE-1', retry))
      .toBeInstanceOf(JournalReinstatesCancelledDocumentError);
    expect(ledgerLinkRefusal(pg({ code: '23514', constraint: 'gl_je_reversal_chain_full' }), 'JE-1', retry))
      .toBeInstanceOf(JournalReversalChainFullError);
  });

  it('answers the chain-changed race and the READ COMMITTED rule (40001) with the retryable 503 error', () => {
    const changed = ledgerLinkRefusal(pg({ code: '40001', constraint: 'gl_je_reversal_chain_changed' }), 'JE-1', retry);
    expect(changed).toBeInstanceOf(JournalReversalLockTimeoutError);
    expect((changed as { code: string }).code).toMatch(/_LOCK_TIMEOUT$/); // lib/lockTimeout: a 503 with Retry-After
    expect(ledgerLinkRefusal(pg({ code: '40001', message: 'gl_journal_entries: ledger links are written at READ COMMITTED only' }), 'JE-1', retry))
      .toBeInstanceOf(JournalReversalLockTimeoutError);
    expect(ledgerLinkRefusal(pg({ code: '55P03', message: 'canceling statement due to lock timeout' }), 'JE-1', retry)) // round 12
      .toBeInstanceOf(JournalReversalLockTimeoutError);
  });

  it('words the exact-negation refusal for a person, with no table name', () => {
    const e = ledgerLinkRefusal(pg({ code: '23514', constraint: 'gl_je_reversal_not_negation',
      message: "gl_journal_entries: a reversal's lines must be the exact negation of the journal it reverses" }), 'JE-7', retry);
    expect(e).toBeInstanceOf(JournalReversalRefusedError);
    expect(e!.message).toMatch(/^Journal entry JE-7 cannot be reversed: its reversal would not mirror it line for line/);
    expect(e!.message).not.toMatch(/gl_journal/);
  });

  it('strips the table prefix from any other 1018 refusal of the link, and leaves everything else alone', () => {
    const e = ledgerLinkRefusal(pg({ code: '23514', message: 'gl_journal_entries: a reversal chain cannot loop' }), 'JE-2', retry);
    expect(e!.message).toBe('Journal entry JE-2 cannot be reversed: a reversal chain cannot loop.');
    expect(ledgerLinkRefusal(pg({ code: '23505', message: 'duplicate key' }), 'JE-2', retry)).toBeNull();
    expect(ledgerLinkRefusal(pg({ code: '23514', message: 'customer_invoices: something else' }), 'JE-2', retry)).toBeNull();
    expect(ledgerLinkRefusal('not an error', 'JE-2', retry)).toBeNull();
  });
});
