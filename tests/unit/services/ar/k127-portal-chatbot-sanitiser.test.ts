/**
 * K-127 — sanitizeClientResponse mangles ordinary English.
 *
 * INTERNAL_PATTERNS (portalChatbotService.ts:105, :109) match the plain English
 * words SELECT/INSERT/UPDATE/DELETE/FROM/WHERE/JOIN and "query" case-insensitively,
 * and the first pattern deletes everything from the word up to the next .!?.
 * The output is customer-facing text on the invoice portal.
 */
import { describe, expect, it } from 'vitest';
import {
  SANITIZED_FALLBACK,
  sanitizeClientResponse,
} from '../../../../src/modules/accounting/services/ar/portalChatbotService';

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

  it('fails CLOSED when the whole reply was internal SQL', () => {
    // The empty-after-strip case IS the worst case: the entire reply was a
    // query. Returning the original text would hand it to the customer.
    for (const leaked of [
      'SELECT * FROM employees',
      'SELECT id\nFROM users\nWHERE company_id = 1',
      'SELECT/**/id/**/FROM/**/users WHERE company_id = 1',
    ]) {
      const clean = sanitizeClientResponse(leaked);
      expect(clean).toBe(SANITIZED_FALLBACK);
      expect(clean).not.toContain('SELECT');
      expect(clean).not.toContain('company_id');
    }
  });

  it('keeps a reply that joins two invoices in plain English', () => {
    const reply = 'We will join the two invoices and delete nothing where possible.';
    expect(sanitizeClientResponse(reply)).toBe(reply);
  });
});

describe('K-127 sanitizeClientResponse keeps portal English that reads like SQL', () => {
  // The single most likely phrasing on an invoice portal: "select ... from"
  // in one ordinary sentence.
  it.each([
    'Please select the invoice from the list below and click Pay.',
    'Your invoice is in the table above. Please select the correct row from it.',
    'Choose an amount from the dropdown, then update the payment reference.',
    'Here is the table 12 summary you asked for.',
    'Please check column B on the statement.',
  ])('leaves %j untouched', (reply) => {
    expect(sanitizeClientResponse(reply)).toBe(reply);
  });
});

describe('K-127 sanitizeClientResponse drops the whole offending sentence', () => {
  it('does not leak a column list longer than the pattern bound', () => {
    const columns = Array.from({ length: 40 }, (_, i) => `column_name_number_${i}`).join(', ');
    const clean = sanitizeClientResponse(`SELECT ${columns} FROM customer_invoices. Sorry.`);
    expect(clean).not.toContain('column_name_number_0');
    expect(clean).not.toContain('customer_invoices');
    expect(clean).toBe('Sorry.');
  });

  it('does not leak a quoted identifier', () => {
    const clean = sanitizeClientResponse('UPDATE "customer_invoices" SET amount_paid = 5.');
    expect(clean).toBe(SANITIZED_FALLBACK);
  });

  it('sees through a zero-width space wedged into a keyword', () => {
    const clean = sanitizeClientResponse('SEL\u200BECT * FROM gl_accounts.');
    expect(clean).toBe(SANITIZED_FALLBACK);
  });

  it('drops a bare fragment that carries the tenant id', () => {
    const tenant = '8f2b1c44-0000-4000-8000-000000000000';
    const clean = sanitizeClientResponse(
      `Sorry — the JOIN on customers c failed and WHERE company_id = '${tenant}' returned nothing.`,
    );
    expect(clean).not.toContain(tenant);
    expect(clean).not.toContain('company_id');
    expect(clean).toBe(SANITIZED_FALLBACK);
  });

  it('keeps the surrounding sentences when only one is internal', () => {
    const clean = sanitizeClientResponse(
      'Your balance is R1 200. SELECT total_amount FROM customer_invoices WHERE id = 3. Let me know.',
    );
    expect(clean).toBe('Your balance is R1 200. Let me know.');
  });
});
