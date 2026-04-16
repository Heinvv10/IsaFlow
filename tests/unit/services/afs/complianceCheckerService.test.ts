// tests/unit/services/afs/complianceCheckerService.test.ts
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { runComplianceCheck } from '@/modules/accounting/services/afs/complianceCheckerService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DOC_ID  = '11111111-2222-3333-4444-555555555555';

const BASE_DOC = [{ id: DOC_ID, company_id: COMPANY, fiscal_year: 2025, reporting_framework: 'ifrs_smes', status: 'in_review' }];

/** Build a complete set of sections that passes all checks. */
function buildPassingSections() {
  const snapshot = {
    totals: { totalAssets: 200_000, totalLiabilities: 120_000, totalEquity: 80_000 },
    cashAccountBalance: 10_000,
    currentRatio: 1.5,
  };
  return [
    { id: 's1', document_id: DOC_ID, company_id: COMPANY, section_type: 'statement_of_fp',  sort_order: 1, status: 'reviewed', data_snapshot: snapshot, content: { title: 'SFP', blocks: [], comparativePeriod: '2024' }, overrides: null },
    { id: 's2', document_id: DOC_ID, company_id: COMPANY, section_type: 'income_statement', sort_order: 2, status: 'reviewed', data_snapshot: { netLoss: 0 },    content: { title: 'IS',  blocks: [], comparativePeriod: '2024' }, overrides: null },
    { id: 's3', document_id: DOC_ID, company_id: COMPANY, section_type: 'cash_flow',        sort_order: 3, status: 'reviewed', data_snapshot: { closingBalance: 10_000 }, content: { title: 'CF', blocks: [], comparativePeriod: '2024' }, overrides: null },
    { id: 's4', document_id: DOC_ID, company_id: COMPANY, section_type: 'changes_in_equity',sort_order: 4, status: 'reviewed', data_snapshot: { closingTotalEquity: 80_000 }, content: { title: 'CE', blocks: [], comparativePeriod: '2024' }, overrides: null },
    { id: 's5', document_id: DOC_ID, company_id: COMPANY, section_type: 'directors_report', sort_order: 5, status: 'reviewed', data_snapshot: null, content: { title: 'DR', blocks: [] }, overrides: null },
    { id: 's6', document_id: DOC_ID, company_id: COMPANY, section_type: 'note_1',  sort_order: 6, status: 'reviewed', data_snapshot: null, content: { title: 'N1', blocks: [{ type: 'paragraph', text: 'revenue ppe inventory policies' }] }, overrides: null },
    { id: 's7', document_id: DOC_ID, company_id: COMPANY, section_type: 'note_23', sort_order: 7, status: 'reviewed', data_snapshot: null, content: { title: 'N23', blocks: [] }, overrides: null },
    { id: 's8', document_id: DOC_ID, company_id: COMPANY, section_type: 'note_24', sort_order: 8, status: 'reviewed', data_snapshot: null, content: { title: 'N24', blocks: [] }, overrides: null },
    { id: 's9', document_id: DOC_ID, company_id: COMPANY, section_type: 'note_26', sort_order: 9, status: 'reviewed', data_snapshot: null, content: { title: 'N26', blocks: [{ type: 'paragraph', text: 'No subsequent events' }] }, overrides: null },
  ];
}

/** Build mandatory templates with 3 entries that match passing sections */
function buildPassingTemplates() {
  return [
    { id: 't1', section_type: 'note_1',  framework: 'both',      title: 'Accounting Policies', is_mandatory: true },
    { id: 't2', section_type: 'note_23', framework: 'ifrs_smes', title: 'Directors info',       is_mandatory: true },
    { id: 't3', section_type: 'note_24', framework: 'both',      title: 'Auditor remuneration', is_mandatory: true },
  ];
}

describe('complianceCheckerService', () => {
  beforeEach(() => vi.clearAllMocks());

  function mockDocSectionsTemplates(
    sections = buildPassingSections(),
    templates = buildPassingTemplates()
  ) {
    mockSql
      .mockResolvedValueOnce(BASE_DOC)
      .mockResolvedValueOnce(sections)
      .mockResolvedValueOnce(templates);
  }

  it('returns score 100 when all checks pass', async () => {
    mockDocSectionsTemplates();
    const result = await runComplianceCheck(COMPANY, DOC_ID);

    // No blockers, no warnings → score = 100
    expect(result.blockerCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.score).toBe(100);
  });

  it('blocker: balance sheet does not balance', async () => {
    const badSnapshot = {
      totals: { totalAssets: 100_000, totalLiabilities: 60_000, totalEquity: 30_000 }, // gap = 10_000
      cashAccountBalance: 5_000,
      currentRatio: 1.5,
    };
    const sections = buildPassingSections().map(s =>
      s.section_type === 'statement_of_fp' ? { ...s, data_snapshot: badSnapshot } : s
    );
    mockDocSectionsTemplates(sections);
    const result = await runComplianceCheck(COMPANY, DOC_ID);

    const issue = result.issues.find(i => i.checkId === 'mathematical.balance_sheet_balances');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('blocker');
    expect(result.score).toBeLessThan(100);
  });

  it('blocker: mandatory note missing from sections', async () => {
    const sections = buildPassingSections().filter(s => s.section_type !== 'note_23');
    const templates = [
      ...buildPassingTemplates(),
      { id: 't99', section_type: 'note_23', framework: 'ifrs_smes', title: 'Directors', is_mandatory: true },
    ];
    mockDocSectionsTemplates(sections, templates);
    const result = await runComplianceCheck(COMPANY, DOC_ID);

    const issue = result.issues.find(i => i.checkId === 'structural.mandatory_notes_present');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('blocker');
  });

  it('warning: comparative figures absent from statement section', async () => {
    const sections = buildPassingSections().map(s =>
      s.section_type === 'statement_of_fp'
        ? { ...s, content: { title: 'SFP', blocks: [] } } // no comparativePeriod
        : s
    );
    mockDocSectionsTemplates(sections);
    const result = await runComplianceCheck(COMPANY, DOC_ID);

    const issue = result.issues.find(i => i.checkId === 'structural.comparative_figures_present');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('warning');
  });

  it('warning: note_26 missing content and no suppressReason', async () => {
    const sections = buildPassingSections().map(s =>
      s.section_type === 'note_26'
        ? { ...s, content: { title: 'N26', blocks: [] }, overrides: null }
        : s
    );
    mockDocSectionsTemplates(sections);
    const result = await runComplianceCheck(COMPANY, DOC_ID);

    const issue = result.issues.find(i => i.checkId === 'disclosure.note26_events_declared');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('warning');
  });

  it('warning: going concern triggered when currentRatio < 1.0 and note_27 pending', async () => {
    const lowCrSnapshot = {
      totals: { totalAssets: 200_000, totalLiabilities: 120_000, totalEquity: 80_000 },
      cashAccountBalance: 10_000,
      currentRatio: 0.8,
    };
    const sectionsBase = buildPassingSections().map(s =>
      s.section_type === 'statement_of_fp' ? { ...s, data_snapshot: lowCrSnapshot } : s
    );
    // Add note_27 in pending state
    const sections = [
      ...sectionsBase,
      { id: 'sn27', document_id: DOC_ID, company_id: COMPANY, section_type: 'note_27', sort_order: 27, status: 'pending', data_snapshot: null, content: null, overrides: null },
    ];
    mockDocSectionsTemplates(sections);
    const result = await runComplianceCheck(COMPANY, DOC_ID);

    const issue = result.issues.find(i => i.checkId === 'disclosure.note27_going_concern');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('warning');
  });

  it('warning: income tax effective rate > 35%', async () => {
    const sections = buildPassingSections().concat([{
      id: 'sn17', document_id: DOC_ID, company_id: COMPANY, section_type: 'note_17', sort_order: 17,
      status: 'reviewed',
      data_snapshot: { taxExpense: 40_000, profitBeforeTax: 100_000 },
      content: null,
      overrides: null,
    }]);
    mockDocSectionsTemplates(sections);
    const result = await runComplianceCheck(COMPANY, DOC_ID);

    const issue = result.issues.find(i => i.checkId === 'mathematical.income_tax_effective_rate');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('warning');
    expect(issue?.detail).toContain('40%');
  });

  it('info: skips cash flow check when section is pending', async () => {
    const sections = buildPassingSections().map(s =>
      s.section_type === 'cash_flow'
        ? { ...s, status: 'pending', data_snapshot: null }
        : s
    );
    mockDocSectionsTemplates(sections);
    const result = await runComplianceCheck(COMPANY, DOC_ID);

    const issue = result.issues.find(i => i.checkId === 'mathematical.cash_flow_closing_balance');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('info');
    expect(issue?.message).toContain('deferred');
  });
});
