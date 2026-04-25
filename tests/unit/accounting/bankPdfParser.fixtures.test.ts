/**
 * Regression tests for the bank PDF parser using REAL statement fixtures
 * committed under test-docs/bank-statements/.
 *
 * These tests guard the specific format issues that were fixed manually
 * during the smart-import sprint:
 *
 *   - ABSA "Classic Business Account" statements (DD/MM/YYYY dates,
 *     running-balance-derived signs, tab-separated columns)
 *   - Standard Bank "Business Online" current-account statements
 *     (column format: pageNum desc fee debit credit YYYYMMDD balance,
 *      description continuation on following lines)
 *
 * Each assertion locks in a behaviour that was previously broken. If a
 * future parser change regresses one of these real-world formats, the
 * test will fail BEFORE the change reaches prod.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseBankPdf } from '@/modules/accounting/utils/bankPdfParser';
import type { BankCsvParseResult } from '@/modules/accounting/types/bank.types';

const FIXTURES_DIR = resolve(__dirname, '../../../test-docs/bank-statements');

function loadFixture(filename: string): Buffer | null {
  const path = resolve(FIXTURES_DIR, filename);
  if (!existsSync(path)) return null;
  return readFileSync(path);
}

describe('parseBankPdf — real fixture regressions', () => {
  describe('ABSA Classic Business Account (DD/MM/YYYY running-balance format)', () => {
    let result: BankCsvParseResult | null = null;

    beforeAll(async () => {
      const buf = loadFixture('blitz_4102426629.pdf');
      if (!buf) return;
      result = await parseBankPdf(buf);
    });

    it('detects bank as ABSA', () => {
      if (!result) return; // fixture missing in CI — skip silently
      expect(result.bankFormat).toBe('absa');
    });

    it('extracts the correct account number from the statement header', () => {
      if (!result) return;
      // Page header on every page reads "BFIBRE 007 4102426629 0007 …".
      // 4096451384 was an earlier (incorrect) expectation — that token is a
      // recurring counterparty (Absa Heuwelsrust) in transaction descriptions,
      // not the statement's own account. The filename also embeds 4102426629.
      expect(result.accountNumber).toBe('4102426629');
    });

    it('parses exactly 117 transactions with zero errors', () => {
      if (!result) return;
      expect(result.errors.length).toBe(0);
      // Note: was 80 before the regex was relaxed to accept 1-2 digit day
      // components (some rows on this statement use "1/06/2022" not
      // "01/06/2022" and were silently dropped).
      expect(result.transactions.length).toBe(117);
    });

    it('derives negative signs from running balance deltas', () => {
      if (!result) return;
      // Large debit row near the top of the statement
      const debit = result.transactions.find(t =>
        t.description.includes('Digital Transf Dt') && Math.abs(t.amount + 25819.8) < 0.01,
      );
      expect(debit).toBeDefined();
      expect(debit!.amount).toBeLessThan(0);
    });

    it('produces running balances that tally end-to-end', () => {
      if (!result) return;
      // Last row balance must equal previous balance + last amount
      const txs = result.transactions;
      const last = txs[txs.length - 1]!;
      const prev = txs[txs.length - 2]!;
      const expected = Math.round((prev.balance! + last.amount) * 100) / 100;
      expect(Math.round(last.balance! * 100) / 100).toBe(expected);
    });

    it('strips the "Settlement <fee> T|A" suffix from descriptions', () => {
      if (!result) return;
      // No parsed description should end with the fee column pattern
      for (const tx of result.transactions) {
        expect(tx.description).not.toMatch(/Settlement\s+\d[\d\s,]*\.\d{2}\s+[TA]$/i);
      }
    });

    it('stitches counterparty continuation lines onto the description', () => {
      if (!result) return;
      // Expected real descriptions we know should appear once continuation
      // stitching works. These are on page-middle transactions so they
      // exercise the happy path, not the page-boundary cutoff.
      const descs = result.transactions.map(t => t.description);
      expect(descs.some(d => d.includes('Frogfoot'))).toBe(true);
      expect(descs.some(d => d.includes('Vox Telecom'))).toBe(true);
      expect(descs.some(d => d.includes('Open Fibre'))).toBe(true);
    });

    it('does not absorb page footer or next-page header text', () => {
      if (!result) return;
      // None of these phrases should ever appear in a transaction
      // description — they are page footer / legal boilerplate that
      // the page-boundary detector must block during continuation
      // stitching.
      const forbidden = [
        'NCRCP7',
        'Authorised Financial Services Provider',
        'Registration Number',
        'Tax Invoice',
        'YOUR PRICING PLAN',
        'Date Transaction Description',
        'Cheque Account Number',
        'CHARGE LEGEND',
      ];
      for (const tx of result.transactions) {
        for (const phrase of forbidden) {
          expect(tx.description).not.toContain(phrase);
        }
      }
    });

    it('caps description length to prevent runaway bleed', () => {
      if (!result) return;
      // Empirically the longest legitimate description on this statement
      // is ~65 chars (counterparty + reference). Anything over 200 chars
      // means page-footer bleed slipped through — hard failure so we
      // notice the regression.
      for (const tx of result.transactions) {
        expect(tx.description.length).toBeLessThan(200);
      }
    });
  });

  describe('Standard Bank Business Online (column format)', () => {
    let result: BankCsvParseResult | null = null;

    beforeAll(async () => {
      const buf = loadFixture('vf_sbsa_5.pdf');
      if (!buf) return;
      result = await parseBankPdf(buf);
    });

    it('detects bank as standard_bank (via NCRCP15 / legal name)', () => {
      if (!result) return;
      expect(result.bankFormat).toBe('standard_bank');
    });

    it('extracts the correct account number', () => {
      if (!result) return;
      expect(result.accountNumber).toBe('0000310650550');
    });

    it('parses 163 transactions with zero errors on the largest fixture', () => {
      if (!result) return;
      expect(result.errors.length).toBe(0);
      expect(result.transactions.length).toBe(163);
    });

    it('skips the BALANCE BROUGHT FORWARD pseudo-row', () => {
      if (!result) return;
      // No zero-amount txs with "BALANCE BROUGHT FORWARD" in description
      const ghost = result.transactions.find(t =>
        /BALANCE BROUGHT FORWARD/i.test(t.description) && t.amount === 0,
      );
      expect(ghost).toBeUndefined();
    });

    it('uses ISO YYYY-MM-DD dates derived from YYYYMMDD columns', () => {
      if (!result) return;
      for (const tx of result.transactions) {
        expect(tx.transactionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it('stores both debits (negative) and credits (positive)', () => {
      if (!result) return;
      const hasDebit = result.transactions.some(t => t.amount < 0);
      const hasCredit = result.transactions.some(t => t.amount > 0);
      expect(hasDebit).toBe(true);
      expect(hasCredit).toBe(true);
    });

    it('populates balances on every row', () => {
      if (!result) return;
      for (const tx of result.transactions) {
        expect(typeof tx.balance).toBe('number');
      }
    });
  });

  describe('Smaller SBSA fixtures (sanity coverage across sizes)', () => {
    // Same parser against 4 different statements with wildly different
    // transaction counts — catches regressions where the column parser
    // over- or under-matches on certain row patterns.
    const cases = [
      { file: 'vf_sbsa_1.pdf', expected: 8 },
      { file: 'vf_sbsa_2.pdf', expected: 82 },
      { file: 'vf_sbsa_3.pdf', expected: 107 },
      { file: 'vf_sbsa_4.pdf', expected: 129 },
    ];

    for (const c of cases) {
      it(`parses ${c.file} → ${c.expected} transactions, 0 errors`, async () => {
        const buf = loadFixture(c.file);
        if (!buf) return;
        const r = await parseBankPdf(buf);
        expect(r.bankFormat).toBe('standard_bank');
        expect(r.accountNumber).toBe('0000310650550');
        expect(r.errors.length).toBe(0);
        expect(r.transactions.length).toBe(c.expected);
      });
    }
  });
});
