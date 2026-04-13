// RED phase — written before implementation
/**
 * Banking Reconciliation — Pure Logic Unit Tests
 *
 * Coverage map:
 *   bankCsvParsers.ts             — parseFNBStatement, parseStandardBankStatement,
 *                                   parseNedbankStatement, parseABSAStatement,
 *                                   parseCapitecStatement, detectBankFormat
 *   bankTransactionQueryService.ts — fmtDate, mapTxRow
 *   fuzzyMatcher.ts               — fuzzyMatch, fuzzyRank
 *
 * Skipped (no pure exports — all functions touch sql/db/network):
 *   bankRulesService.ts           — toSqlPattern and mapRuleRow are not exported
 *   bankAllocationService.ts      — all exports call sql
 *   bankFeedService.ts            — re-export facade only
 *   bankFeedSyncService.ts        — all exports call sql + graphqlQuery
 *   bankImportService.ts          — all exports call sql/transaction
 *   duplicateDetectionService.ts  — all exports call sql (fuzzyMatch tested via fuzzyMatcher)
 *   cashFlowForecastService.ts    — all exports call sql
 *
 * The @/lib/neon module is stubbed at the vi.mock level so that importing
 * bankTransactionQueryService (which has a module-level sql tagged template)
 * does not throw "DATABASE_URL is not set" during test collection.
 */

import { describe, it, expect, vi } from 'vitest';

// Stub the neon module before any service imports touch it.
// The sql tag function must return a thenable so module-level sql`...`
// expressions (like TX_SELECT) resolve without hitting a real database.
vi.mock('@/lib/neon', () => {
  const noopTag = () => Promise.resolve([]);
  // Attach .unsafe() helper that bankTransactionQueryService uses inline
  (noopTag as unknown as Record<string, unknown>).unsafe = (s: string) => s;
  return {
    sql: noopTag,
    transaction: (_cb: unknown) => Promise.resolve(),
  };
});

import {
  parseFNBStatement,
  parseStandardBankStatement,
  parseNedbankStatement,
  parseABSAStatement,
  parseCapitecStatement,
  detectBankFormat,
} from '@/modules/accounting/utils/bankCsvParsers';

import {
  fmtDate,
  mapTxRow,
} from '@/modules/accounting/services/bank/bankTransactionQueryService';

import {
  fuzzyMatch,
  fuzzyRank,
} from '@/modules/accounting/utils/fuzzyMatcher';

// ── Shared fixtures ───────────────────────────────────────────────────────────

const FNB_HEADER = '"Date","Description","Amount","Balance","Reference"';

const STANDARD_BANK_HEADER = 'Date,Description,Debit,Credit,Balance';

const NEDBANK_HEADER =
  'Transaction Date,Value Date,Transaction Description,Debit Amount,Credit Amount,Balance';

const ABSA_HEADER =
  'Account Number,Date,Description1,Description2,Amount,Balance';

const CAPITEC_HEADER = 'Date,Description,Debit,Credit,Balance';

// ── detectBankFormat ──────────────────────────────────────────────────────────

describe('detectBankFormat', () => {
  it('detects FNB by quoted Date + Amount + Reference headers', () => {
    const csv = `${FNB_HEADER}\n"2026/01/15","Salary","+15000.00","55000.00","SAL-JAN"`;
    expect(detectBankFormat(csv)).toBe('fnb');
  });

  it('detects Nedbank by Transaction Date + Value Date columns', () => {
    const csv = `${NEDBANK_HEADER}\n2026-01-10,2026-01-10,Grocery Store,500.00,,18500.00`;
    expect(detectBankFormat(csv)).toBe('nedbank');
  });

  it('detects ABSA by Account Number + Description1 headers', () => {
    const csv = `${ABSA_HEADER}\n4087123456,2026/01/15,POS Purchase,Woolworths,-1234.56,45678.90`;
    expect(detectBankFormat(csv)).toBe('absa');
  });

  it('detects Capitec by exact 5-column Date,Description,Debit,Credit,Balance header', () => {
    const csv = `${CAPITEC_HEADER}\n15/01/2026,Grocery,500.00,,14500.00`;
    expect(detectBankFormat(csv)).toBe('capitec');
  });

  it('detects Standard Bank when debit+credit present but not exactly 5 Capitec columns', () => {
    const csv = `Date,Description,Debit,Credit,Balance,Batch No\n15/01/2026,ATM,200.00,,14300.00,001`;
    expect(detectBankFormat(csv)).toBe('standard_bank');
  });

  it('detects OFX format by OFXHEADER prefix', () => {
    const csv = 'OFXHEADER:100\nDATA:OFXSGML';
    expect(detectBankFormat(csv)).toBe('ofx');
  });

  it('detects OFX format by <OFX> XML tag', () => {
    const csv = '<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>';
    expect(detectBankFormat(csv)).toBe('ofx');
  });

  it('detects QIF format by !Type: prefix', () => {
    const csv = '!Type:Bank\nD01/15/2026\nT-500.00\n^';
    expect(detectBankFormat(csv)).toBe('qif');
  });

  it('returns unknown for empty string', () => {
    expect(detectBankFormat('')).toBe('unknown');
  });

  it('returns unknown for unrecognised header', () => {
    const csv = 'Ref,Narration,Value\nXYZ,Some payment,100';
    expect(detectBankFormat(csv)).toBe('unknown');
  });
});

// ── parseFNBStatement ─────────────────────────────────────────────────────────

describe('parseFNBStatement', () => {
  it('parses a standard deposit row', () => {
    const csv = [
      FNB_HEADER,
      '"2026/01/15","Monthly Salary","+25000.00","50000.00","EMP-001"',
    ].join('\n');
    const result = parseFNBStatement(csv);
    expect(result.transactions).toHaveLength(1);
    const tx = result.transactions[0]!;
    expect(tx.transactionDate).toBe('2026-01-15');
    expect(tx.amount).toBe(25000);
    expect(tx.description).toBe('Monthly Salary');
    expect(tx.reference).toBe('EMP-001');
    expect(tx.balance).toBe(50000);
  });

  it('parses a negative withdrawal row', () => {
    const csv = [
      FNB_HEADER,
      '"2026/01/20","Rent Payment","-12000.00","38000.00","RENT-JAN"',
    ].join('\n');
    const result = parseFNBStatement(csv);
    expect(result.transactions[0]!.amount).toBe(-12000);
  });

  it('returns empty transactions for header-only input', () => {
    const result = parseFNBStatement(FNB_HEADER);
    expect(result.transactions).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('records an error for a row with an invalid date', () => {
    const csv = [FNB_HEADER, '"not-a-date","Test","100.00","100.00",""'].join('\n');
    const result = parseFNBStatement(csv);
    expect(result.transactions).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toMatch(/Invalid date/i);
  });

  it('records an error for a row with an invalid amount', () => {
    const csv = [FNB_HEADER, '"2026/01/15","Test","not-a-number","100.00",""'].join('\n');
    const result = parseFNBStatement(csv);
    expect(result.errors[0]!.error).toMatch(/Invalid amount/i);
  });

  it('sets bankFormat to fnb', () => {
    expect(parseFNBStatement(FNB_HEADER).bankFormat).toBe('fnb');
  });

  it('handles multiple rows producing correct count', () => {
    const rows = [
      FNB_HEADER,
      '"2026/01/10","Groceries","-350.00","49650.00","PICK-001"',
      '"2026/01/12","Transfer In","5000.00","54650.00","TRF-002"',
      '"2026/01/14","Petrol","-800.00","53850.00","SHELL-003"',
    ];
    const result = parseFNBStatement(rows.join('\n'));
    expect(result.transactions).toHaveLength(3);
    expect(result.errors).toHaveLength(0);
  });
});

// ── parseStandardBankStatement ────────────────────────────────────────────────

describe('parseStandardBankStatement', () => {
  it('parses a credit row as positive amount', () => {
    const csv = [
      STANDARD_BANK_HEADER,
      '15/01/2026,Customer Payment,,15000.00,65000.00',
    ].join('\n');
    const result = parseStandardBankStatement(csv);
    expect(result.transactions[0]!.amount).toBe(15000);
    expect(result.transactions[0]!.transactionDate).toBe('2026-01-15');
  });

  it('parses a debit row as negative amount', () => {
    const csv = [
      STANDARD_BANK_HEADER,
      '20/01/2026,Insurance Premium,2500.00,,62500.00',
    ].join('\n');
    const result = parseStandardBankStatement(csv);
    expect(result.transactions[0]!.amount).toBe(-2500);
  });

  it('records error when both debit and credit are absent', () => {
    const csv = [
      STANDARD_BANK_HEADER,
      '20/01/2026,Unknown Row,,,62500.00',
    ].join('\n');
    const result = parseStandardBankStatement(csv);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toMatch(/no debit or credit/i);
  });

  it('sets bankFormat to standard_bank', () => {
    expect(parseStandardBankStatement(STANDARD_BANK_HEADER).bankFormat).toBe('standard_bank');
  });
});

// ── parseNedbankStatement ─────────────────────────────────────────────────────

describe('parseNedbankStatement', () => {
  it('parses a credit transaction including value date', () => {
    const csv = [
      NEDBANK_HEADER,
      '2026-01-15,2026-01-15,Salary Credit,,20000.00,40000.00',
    ].join('\n');
    const result = parseNedbankStatement(csv);
    const tx = result.transactions[0]!;
    expect(tx.transactionDate).toBe('2026-01-15');
    expect(tx.valueDate).toBe('2026-01-15');
    expect(tx.amount).toBe(20000);
    expect(tx.description).toBe('Salary Credit');
  });

  it('parses a debit transaction as negative amount', () => {
    const csv = [
      NEDBANK_HEADER,
      '2026-01-18,2026-01-18,Electricity,3200.00,,36800.00',
    ].join('\n');
    const result = parseNedbankStatement(csv);
    expect(result.transactions[0]!.amount).toBe(-3200);
  });

  it('sets bankFormat to nedbank', () => {
    expect(parseNedbankStatement(NEDBANK_HEADER).bankFormat).toBe('nedbank');
  });

  it('reports error for invalid date format', () => {
    const csv = [NEDBANK_HEADER, 'bad-date,bad-date,Test,100,,'].join('\n');
    const result = parseNedbankStatement(csv);
    expect(result.errors[0]!.error).toMatch(/Invalid date/i);
  });
});

// ── parseABSAStatement ────────────────────────────────────────────────────────

describe('parseABSAStatement', () => {
  it('parses combined Description1 + Description2 into a single description', () => {
    const csv = [
      ABSA_HEADER,
      '4087123456,2026/01/15,POS Purchase,Woolworths Food,-1234.56,45678.90',
    ].join('\n');
    const result = parseABSAStatement(csv);
    const tx = result.transactions[0]!;
    expect(tx.description).toBe('POS Purchase Woolworths Food');
    expect(tx.amount).toBe(-1234.56);
    expect(tx.transactionDate).toBe('2026-01-15');
  });

  it('uses only Description1 when Description2 is empty', () => {
    const csv = [
      ABSA_HEADER,
      '4087123456,2026/01/16,Internet Transfer,,-5000.00,40678.90',
    ].join('\n');
    const result = parseABSAStatement(csv);
    expect(result.transactions[0]!.description).toBe('Internet Transfer');
  });

  it('skips blank lines without recording an error', () => {
    const csv = [ABSA_HEADER, ',,,,,', '4087123456,2026/01/15,ATM Cash,,500.00,41178.90'].join('\n');
    const result = parseABSAStatement(csv);
    // Blank line should be silently skipped
    expect(result.transactions).toHaveLength(1);
  });

  it('sets bankFormat to absa', () => {
    expect(parseABSAStatement(ABSA_HEADER).bankFormat).toBe('absa');
  });
});

// ── parseCapitecStatement ─────────────────────────────────────────────────────

describe('parseCapitecStatement', () => {
  it('parses a debit as negative amount', () => {
    const csv = [CAPITEC_HEADER, '15/01/2026,Grocery Shop,500.00,,14500.00'].join('\n');
    const result = parseCapitecStatement(csv);
    expect(result.transactions[0]!.amount).toBe(-500);
    expect(result.transactions[0]!.transactionDate).toBe('2026-01-15');
  });

  it('parses a credit as positive amount', () => {
    const csv = [CAPITEC_HEADER, '17/01/2026,Client Payment,,8000.00,22500.00'].join('\n');
    const result = parseCapitecStatement(csv);
    expect(result.transactions[0]!.amount).toBe(8000);
  });

  it('silently skips fully blank lines', () => {
    const csv = [CAPITEC_HEADER, ',,,,,', '17/01/2026,Client Payment,,8000.00,22500.00'].join('\n');
    const result = parseCapitecStatement(csv);
    expect(result.transactions).toHaveLength(1);
  });

  it('records error when both debit and credit are absent', () => {
    const csv = [CAPITEC_HEADER, '17/01/2026,Mysterious Row,,,'].join('\n');
    const result = parseCapitecStatement(csv);
    expect(result.errors[0]!.error).toMatch(/no debit or credit/i);
  });

  it('sets bankFormat to capitec', () => {
    expect(parseCapitecStatement(CAPITEC_HEADER).bankFormat).toBe('capitec');
  });
});

// ── fmtDate ───────────────────────────────────────────────────────────────────

describe('fmtDate', () => {
  it('extracts YYYY-MM-DD from a JS Date object', () => {
    const d = new Date('2026-03-15T10:00:00.000Z');
    expect(fmtDate(d)).toBe('2026-03-15');
  });

  it('extracts date portion from an ISO string with time component', () => {
    expect(fmtDate('2026-03-15T14:30:00.000Z')).toBe('2026-03-15');
  });

  it('returns a plain YYYY-MM-DD string unchanged', () => {
    expect(fmtDate('2026-01-31')).toBe('2026-01-31');
  });

  it('returns empty string for null-like falsy values', () => {
    expect(fmtDate(null)).toBe('');
    expect(fmtDate(undefined)).toBe('');
    expect(fmtDate('')).toBe('');
  });
});

// ── mapTxRow ──────────────────────────────────────────────────────────────────

describe('mapTxRow', () => {
  const baseRow: Record<string, unknown> = {
    id: 'tx-uuid-001',
    bank_account_id: 'acct-uuid-001',
    transaction_date: '2026-01-15',
    value_date: null,
    amount: '-5000',
    description: 'Office Supplies',
    reference: 'INV-2026-001',
    bank_reference: 'BNK-REF-999',
    status: 'imported',
    matched_journal_line_id: null,
    reconciliation_id: null,
    import_batch_id: 'batch-uuid-001',
    exclude_reason: null,
    notes: null,
    suggested_gl_account_id: null,
    suggested_gl_account_name: null,
    suggested_gl_account_code: null,
    suggested_category: null,
    suggested_cost_centre: null,
    suggested_vat_code: 'none',
    suggested_confidence: null,
    suggested_supplier_id: null,
    suggested_supplier_name: null,
    suggested_client_id: null,
    suggested_client_name: null,
    cc1_id: null,
    cc2_id: null,
    bu_id: null,
    cc1_name: null,
    cc2_name: null,
    bu_name: null,
    allocation_type: null,
    allocated_entity_name: null,
    created_at: '2026-01-15T08:00:00Z',
    updated_at: '2026-01-15T08:00:00Z',
    bank_account_name: 'FNB Business Cheque',
    matched_entry_number: null,
  };

  it('maps core fields correctly', () => {
    const tx = mapTxRow(baseRow);
    expect(tx.id).toBe('tx-uuid-001');
    expect(tx.bankAccountId).toBe('acct-uuid-001');
    expect(tx.amount).toBe(-5000);
    expect(tx.description).toBe('Office Supplies');
    expect(tx.status).toBe('imported');
    expect(tx.bankAccountName).toBe('FNB Business Cheque');
  });

  it('converts string amount to number', () => {
    const tx = mapTxRow({ ...baseRow, amount: '12345.67' });
    expect(tx.amount).toBe(12345.67);
  });

  it('maps optional suggestion fields when present', () => {
    const row = {
      ...baseRow,
      suggested_gl_account_id: 'gl-uuid-001',
      suggested_gl_account_name: 'Office Expenses',
      suggested_gl_account_code: '7100',
      suggested_category: 'Admin Rule',
      suggested_vat_code: 'standard',
      suggested_confidence: '0.95',
    };
    const tx = mapTxRow(row);
    expect(tx.suggestedGlAccountId).toBe('gl-uuid-001');
    expect(tx.suggestedGlAccountName).toBe('Office Expenses');
    expect(tx.suggestedGlAccountCode).toBe('7100');
    expect(tx.suggestedCategory).toBe('Admin Rule');
    expect(tx.suggestedVatCode).toBe('standard');
    expect(tx.suggestedConfidence).toBeCloseTo(0.95, 5);
  });

  it('leaves suggestedVatCode undefined when value is "none"', () => {
    const tx = mapTxRow({ ...baseRow, suggested_vat_code: 'none' });
    expect(tx.suggestedVatCode).toBeUndefined();
  });

  it('maps allocation tracking fields', () => {
    const row = {
      ...baseRow,
      allocation_type: 'supplier',
      allocated_entity_name: 'Acme Supplies (Pty) Ltd',
      status: 'matched',
    };
    const tx = mapTxRow(row);
    expect(tx.allocationType).toBe('supplier');
    expect(tx.allocatedEntityName).toBe('Acme Supplies (Pty) Ltd');
    expect(tx.status).toBe('matched');
  });

  it('maps dimension (cost centre / BU) fields when present', () => {
    const row = {
      ...baseRow,
      cc1_id: 'cc-001',
      cc1_name: 'Cape Town Branch',
      bu_id: 'bu-001',
      bu_name: 'Retail Division',
    };
    const tx = mapTxRow(row);
    expect(tx.cc1Id).toBe('cc-001');
    expect(tx.cc1Name).toBe('Cape Town Branch');
    expect(tx.buId).toBe('bu-001');
    expect(tx.buName).toBe('Retail Division');
  });

  it('leaves optional fields undefined when DB columns are null', () => {
    const tx = mapTxRow(baseRow);
    expect(tx.valueDate).toBeUndefined();
    expect(tx.matchedJournalLineId).toBeUndefined();
    expect(tx.reconciliationId).toBeUndefined();
    expect(tx.excludeReason).toBeUndefined();
    expect(tx.notes).toBeUndefined();
    expect(tx.suggestedVatCode).toBeUndefined();
  });
});

// ── fuzzyMatch ────────────────────────────────────────────────────────────────

describe('fuzzyMatch', () => {
  it('returns exact match with score 1.0', () => {
    const result = fuzzyMatch('Acme Holdings', ['Acme Holdings', 'Other Corp'], 0.7);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(1.0);
    expect(result!.match).toBe('Acme Holdings');
  });

  it('matches a name despite (Pty) Ltd suffix difference — normalization strips legal suffixes', () => {
    // 'acme holdings pty ltd' normalizes to 'acme holdings'
    const result = fuzzyMatch('Acme Holdings (Pty) Ltd', ['Acme Holdings'], 0.8);
    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThanOrEqual(0.8);
  });

  it('returns null when best candidate is below threshold', () => {
    const result = fuzzyMatch('Woolworths Food SA', ['Pick n Pay', 'Spar Holdings'], 0.7);
    expect(result).toBeNull();
  });

  it('returns null for an empty needle', () => {
    const result = fuzzyMatch('', ['Any Name'], 0.7);
    expect(result).toBeNull();
  });

  it('returns null for an empty haystack', () => {
    const result = fuzzyMatch('Some Name', [], 0.7);
    expect(result).toBeNull();
  });

  it('picks the highest-scoring candidate when multiple pass threshold', () => {
    const result = fuzzyMatch('Transnet SOC Ltd', [
      'Transnet Freight Rail',
      'Transnet SOC Limited',
      'Eskom Holdings SOC',
    ], 0.6);
    expect(result).not.toBeNull();
    // 'Transnet SOC Limited' should score higher than 'Transnet Freight Rail'
    expect(result!.match).toBe('Transnet SOC Limited');
  });

  it('handles single-character needle gracefully without crashing', () => {
    // Should not throw; may return null due to low similarity
    expect(() => fuzzyMatch('X', ['XYZ Corp', 'ABC Ltd'], 0.7)).not.toThrow();
  });

  it('is case-insensitive via normalization', () => {
    const result = fuzzyMatch('DISCOVERY HEALTH', ['Discovery Health'], 0.9);
    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThanOrEqual(0.9);
  });
});

// ── fuzzyRank ─────────────────────────────────────────────────────────────────

describe('fuzzyRank', () => {
  it('returns empty array for empty haystack', () => {
    expect(fuzzyRank('Standard Bank', [], 0.5)).toEqual([]);
  });

  it('returns empty array for empty needle', () => {
    expect(fuzzyRank('', ['Nedbank', 'ABSA'], 0.5)).toEqual([]);
  });

  it('returns candidates sorted by score descending', () => {
    const results = fuzzyRank('Nedbank', [
      'First National Bank',
      'Nedbank Limited',
      'Nedbank',
      'Old Mutual',
    ], 0.5);
    expect(results.length).toBeGreaterThan(0);
    // Verify descending order
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i]!.score).toBeGreaterThanOrEqual(results[i + 1]!.score);
    }
    // The normalizer strips 'Ltd'/'Limited' so both 'Nedbank' and 'Nedbank Limited'
    // normalize to 'nedbank' and score 1.0.  The top result must be one of them.
    expect(['Nedbank', 'Nedbank Limited']).toContain(results[0]!.match);
    expect(results[0]!.score).toBe(1.0);
  });

  it('filters out candidates below the threshold', () => {
    const results = fuzzyRank('Capitec Bank', ['ABSA Bank', 'FNB Bank', 'Nedbank'], 0.8);
    // None of these should be close enough to 'Capitec Bank' at 0.8 threshold
    expect(results).toHaveLength(0);
  });

  it('includes candidates above the default 0.5 threshold', () => {
    const results = fuzzyRank('Discovery Life', ['Discovery Health', 'Discovery Life Ltd'], 0.5);
    expect(results.length).toBeGreaterThan(0);
    results.forEach(r => expect(r.score).toBeGreaterThanOrEqual(0.5));
  });
});
