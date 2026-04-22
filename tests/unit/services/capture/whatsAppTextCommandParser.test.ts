// RED phase — written before implementation
/**
 * Unit tests for whatsAppTextCommandParser.ts — PRD-05 Phase 8
 *
 * Pure function tests: parseExpenseCommand
 * Covers amount parsing, supplier extraction, payment method inference,
 * edge cases (zero, decimal, malformed, noise, missing fields).
 */

import { describe, it, expect } from 'vitest';
import {
  parseExpenseCommand,
  type WhatsAppExpenseCommand,
} from '@/modules/accounting/services/capture/whatsAppTextCommandParser';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parsed(body: string): WhatsAppExpenseCommand {
  const result = parseExpenseCommand(body);
  if (!result) throw new Error(`parseExpenseCommand returned null for: "${body}"`);
  return result;
}

// ─── Core amount parsing ──────────────────────────────────────────────────────

describe('parseExpenseCommand — amount parsing', () => {
  it('parses "paid R850 at Shell" → amount 850', () => {
    expect(parsed('paid R850 at Shell').amount).toBe(850);
  });

  it('parses "spent R120 Kauai lunch" → amount 120', () => {
    expect(parsed('spent R120 Kauai lunch').amount).toBe(120);
  });

  it('parses "R1250 Engen fuel" → amount 1250', () => {
    expect(parsed('R1250 Engen fuel').amount).toBe(1250);
  });

  it('parses "1500 rand Checkers" → amount 1500', () => {
    expect(parsed('1500 rand Checkers').amount).toBe(1500);
  });

  it('parses decimal: "paid R12.50 sweets" → amount 12.5', () => {
    expect(parsed('paid R12.50 sweets').amount).toBeCloseTo(12.5, 2);
  });

  it('returns null for "hello" (no amount)', () => {
    expect(parseExpenseCommand('hello')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseExpenseCommand('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseExpenseCommand('   ')).toBeNull();
  });

  it('returns null for bare number without R/rand context: "just 500 here"', () => {
    expect(parseExpenseCommand('just 500 here')).toBeNull();
  });

  it('parses "R12.5.0 coffee" as 12.5 (regex matches up to first decimal group)', () => {
    // AMOUNT_RE matches R12.5, ignoring the trailing ".0" — verify amount not null
    // and that amount equals the first valid decimal match rather than crashing.
    const result = parseExpenseCommand('R12.5.0 coffee');
    expect(result).not.toBeNull();
    expect(result?.amount).toBeCloseTo(12.5, 2);
  });
});

// ─── Supplier hint extraction ─────────────────────────────────────────────────

describe('parseExpenseCommand — supplier hint', () => {
  it('"paid R850 at Shell" → supplierHint "Shell"', () => {
    expect(parsed('paid R850 at Shell').supplierHint).toBe('Shell');
  });

  it('"spent R120 Kauai lunch" → supplierHint "Kauai" (noise word stripped)', () => {
    expect(parsed('spent R120 Kauai lunch').supplierHint).toBe('Kauai');
  });

  it('"R1250 Engen fuel" → supplierHint "Engen" (fuel stripped)', () => {
    expect(parsed('R1250 Engen fuel').supplierHint).toBe('Engen');
  });

  it('"1500 rand Checkers" → supplierHint "Checkers"', () => {
    expect(parsed('1500 rand Checkers').supplierHint).toBe('Checkers');
  });

  it('"spent R200" (no supplier) → supplierHint null', () => {
    expect(parsed('spent R200').supplierHint).toBeNull();
  });

  it('long tail: extracts amount and payment method from complex string', () => {
    const result = parsed('paid R850 at Shell on the way home, company card, thanks');
    expect(result.amount).toBe(850);
    expect(result.paymentMethod).toBe('company_card');
    // supplier hint contains "Shell" at minimum — exact extent depends on noise stripping
    expect(result.supplierHint).toMatch(/Shell/);
  });
});

// ─── Payment method inference ─────────────────────────────────────────────────

describe('parseExpenseCommand — payment method', () => {
  it('"paid R850 Shell, company card" → paymentMethod company_card', () => {
    expect(parsed('paid R850 Shell, company card').paymentMethod).toBe('company_card');
  });

  it('"R120 CC Checkers" → paymentMethod company_card', () => {
    expect(parsed('R120 CC Checkers').paymentMethod).toBe('company_card');
  });

  it('"R300 eft Telkom" → paymentMethod eft', () => {
    expect(parsed('R300 eft Telkom').paymentMethod).toBe('eft');
  });

  it('"R50 personal" → paymentMethod personal', () => {
    expect(parsed('R50 personal').paymentMethod).toBe('personal');
  });

  it('"R500 debit Shoprite" → paymentMethod company_card (SA: debit ≈ card)', () => {
    expect(parsed('R500 debit Shoprite').paymentMethod).toBe('company_card');
  });

  it('"paid R500 Shell" with no method keyword → paymentMethod null', () => {
    expect(parsed('paid R500 Shell').paymentMethod).toBeNull();
  });
});

// ─── Case resilience ──────────────────────────────────────────────────────────

describe('parseExpenseCommand — case resilience', () => {
  it('uppercase "PAID R500 SHELL" → parses amount 500 and supplier Shell', () => {
    const result = parsed('PAID R500 SHELL');
    expect(result.amount).toBe(500);
    expect(result.supplierHint).toBe('SHELL');
  });
});

// ─── action and description fields ───────────────────────────────────────────

describe('parseExpenseCommand — action and description', () => {
  it('always sets action to "provisional_expense"', () => {
    expect(parsed('R200 Checkers').action).toBe('provisional_expense');
  });

  it('"spent R120 Kauai lunch" → description contains "lunch"', () => {
    expect(parsed('spent R120 Kauai lunch').description).toContain('lunch');
  });

  it('description is the original trimmed body', () => {
    const body = 'paid R850 at Shell';
    expect(parsed(body).description).toBe(body);
  });
});
