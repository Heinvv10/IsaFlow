/**
 * ABSA scraper field-mapping tests.
 *
 * Uses PII-scrubbed fixtures captured 2026-04-29 from a real ABSA Business
 * Banking session via Playwright MCP. These tests are the source of truth
 * for the field mapping — chrome-extension/bank-connector/content/absa.js
 * must produce the same shape.
 */

import { describe, it, expect } from 'vitest';
import {
  mapAbsaAccount,
  mapAbsaAccountList,
  mapAbsaTransactionLine,
  mapAbsaTransactionHistory,
  type AbsaAccountListResponse,
  type AbsaTransactionHistoryResponse,
} from '@/modules/accounting/services/bank/absaScraperMapper';
import balanceEnquiryFixture from './fixtures/absa/balance-enquiry-response.json';
import txHistoryFixture from './fixtures/absa/transaction-history-response.json';

const balanceEnquiry = balanceEnquiryFixture as AbsaAccountListResponse;
const txHistory = txHistoryFixture as AbsaTransactionHistoryResponse;

describe('mapAbsaAccount', () => {
  it('maps a Current account to type "cheque"', () => {
    const out = mapAbsaAccount({ number: '0000000001', name: 'Test Cheque', accountType: 'Current', available: '1455.73', balance: '5446.28' });
    expect(out).toEqual({
      externalAccountId: '0000000001',
      accountNumber: '0000000001',
      displayName: 'Test Cheque',
      type: 'cheque',
      currency: 'ZAR',
      available: 1455.73,
      balance: 5446.28,
    });
  });

  it('maps Savings → savings', () => {
    expect(mapAbsaAccount({ number: '2', accountType: 'Savings' }).type).toBe('savings');
  });

  it('falls back to other for unknown account type', () => {
    expect(mapAbsaAccount({ number: '3', accountType: 'WeirdProduct' }).type).toBe('other');
  });

  it('handles credit-card-style account types', () => {
    expect(mapAbsaAccount({ number: '4', accountType: 'Credit Card' }).type).toBe('credit_card');
  });

  it('synthesises a display name when name is missing', () => {
    expect(mapAbsaAccount({ number: '99' }).displayName).toBe('Account 99');
  });
});

describe('mapAbsaAccountList — fixture round-trip', () => {
  it('maps the 2-account fixture into BankAccountSummary[]', () => {
    const out = mapAbsaAccountList(balanceEnquiry);
    expect(out).toHaveLength(2);
    expect(out[0]?.type).toBe('cheque');
    expect(out[1]?.type).toBe('savings');
    expect(out[0]?.balance).toBe(5446.28);
  });
});

describe('mapAbsaTransactionLine', () => {
  it('parses a debit with description and balance', () => {
    const out = mapAbsaTransactionLine({
      transactionDate: '2026-04-28',
      transactionAmount: '-51745.00',
      balanceAmount: '5446.28',
      transactionDescription: 'DIGITAL PAYMENT DT            (     10,00 ) ABSA BANK Sample Vendor',
      descriptionLine2: 'ABSA BANK Sample Vendor',
    });
    expect(out).toEqual({
      transactionDate: '2026-04-28',
      amount: -51745,
      description: 'DIGITAL PAYMENT DT ( 10,00 ) ABSA BANK Sample Vendor',
      reference: 'ABSA BANK Sample Vendor',
      balance: 5446.28,
    });
  });

  it('parses a credit (positive amount)', () => {
    const out = mapAbsaTransactionLine({
      transactionDate: '2026-04-28',
      transactionAmount: '52000.00',
      balanceAmount: '57191.28',
      transactionDescription: 'DIGITAL PAYMENT CR ABSA BANK Inbound Transfer',
      descriptionLine2: 'ABSA BANK Inbound Transfer',
    });
    expect(out.amount).toBe(52000);
    expect(out.description).toMatch(/^DIGITAL PAYMENT CR/);
  });

  it('omits reference when descriptionLine2 is empty', () => {
    const out = mapAbsaTransactionLine({
      transactionDate: '2026-04-27',
      transactionAmount: '-14.00',
      balanceAmount: '5191.28',
      transactionDescription: 'ARCHIVE STMT ENQ              (     14,00 )',
      descriptionLine2: '',
    });
    expect(out.reference).toBeUndefined();
  });

  it('falls back to placeholder description when blank', () => {
    const out = mapAbsaTransactionLine({
      transactionDate: '2026-04-27',
      transactionAmount: '-1.00',
      balanceAmount: null,
      transactionDescription: '   ',
    });
    expect(out.description).toBe('(no description)');
    expect(out.balance).toBeUndefined();
  });
});

describe('mapAbsaTransactionHistory — fixture round-trip', () => {
  it('maps the 3-row fixture into ParsedBankTransaction[]', () => {
    const out = mapAbsaTransactionHistory(txHistory);
    expect(out).toHaveLength(3);
    // Newest first (sortDirection DESC)
    expect(out[0]?.transactionDate).toBe('2026-04-28');
    expect(out[0]?.amount).toBe(-51745);
    // All rows have a balance from the fixture
    expect(out.every((t: { balance?: number }) => typeof t.balance === 'number')).toBe(true);
  });

  it('produces hashable shapes (date + amount + description + balance)', () => {
    const out = mapAbsaTransactionHistory(txHistory);
    for (const tx of out) {
      expect(tx.transactionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof tx.amount).toBe('number');
      expect(tx.description.length).toBeGreaterThan(0);
    }
  });
});
