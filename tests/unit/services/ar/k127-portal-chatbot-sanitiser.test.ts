/**
 * K-127 — sanitizeClientResponse mangles ordinary English.
 *
 * INTERNAL_PATTERNS (portalChatbotService.ts:105, :109) match the plain English
 * words SELECT/INSERT/UPDATE/DELETE/FROM/WHERE/JOIN and "query" case-insensitively,
 * and the first pattern deletes everything from the word up to the next .!?.
 * The output is customer-facing text on the invoice portal.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeClientResponse } from '../../../../src/modules/accounting/services/ar/portalChatbotService';

describe('K-127 sanitizeClientResponse preserves ordinary English', () => {
  it('keeps a dunning-style sentence containing the word "from" intact', () => {
    const reply = 'Your invoice from March is still outstanding. Please pay by Friday.';
    expect(sanitizeClientResponse(reply)).toBe(reply);
  });

  it('keeps a sentence containing the word "update"', () => {
    const reply = 'I will update your contact details. Thank you.';
    expect(sanitizeClientResponse(reply)).toBe(reply);
  });

  it('keeps a sentence containing the word "query"', () => {
    const reply = 'If you have a query about this account, reply here.';
    expect(sanitizeClientResponse(reply)).toBe(reply);
  });

  it('still strips a real leaked SQL statement', () => {
    const leaked = 'Sure. SELECT * FROM customer_invoices WHERE id = 1. Let me know.';
    expect(sanitizeClientResponse(leaked)).not.toContain('customer_invoices');
  });
});

describe('K-127 sanitizeClientResponse still strips leaked internals', () => {
  it('strips an INSERT statement', () => {
    const leaked = 'Done. INSERT INTO payslips (id) VALUES (1). Anything else?';
    const clean = sanitizeClientResponse(leaked);
    expect(clean).not.toContain('INSERT INTO');
    expect(clean).not.toContain('payslips');
    expect(clean).toContain('Anything else?');
  });

  it('strips an UPDATE ... SET statement while keeping the plain word "update"', () => {
    const leaked = 'I will update your details. UPDATE customers SET name = $1. Done.';
    const clean = sanitizeClientResponse(leaked);
    expect(clean).toContain('I will update your details.');
    expect(clean).not.toContain('SET name');
  });

  it('strips a DELETE FROM statement', () => {
    const leaked = 'DELETE FROM bank_transactions WHERE id = 7. Sorry about that.';
    const clean = sanitizeClientResponse(leaked);
    expect(clean).not.toContain('DELETE FROM');
    expect(clean).not.toContain('bank_transactions');
  });

  it('does not let a SELECT swallow the following sentence', () => {
    const leaked = 'SELECT id FROM gl_accounts. Your balance is R1 200.';
    expect(sanitizeClientResponse(leaked)).toContain('Your balance is R1 200.');
  });

  it('leaves an empty-after-strip reply as the original text', () => {
    const leaked = 'SELECT * FROM employees';
    expect(sanitizeClientResponse(leaked)).toBe(leaked);
  });

  it('keeps a reply that joins two invoices in plain English', () => {
    const reply = 'We will join the two invoices and delete nothing where possible.';
    expect(sanitizeClientResponse(reply)).toBe(reply);
  });
});
