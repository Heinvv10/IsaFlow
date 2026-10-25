/**
 * The practitioner and directors' reports name the period the statements cover:
 * "year ended X" for twelve months, "N months ended X" otherwise, and "for the
 * period then ended" where the wording ran "for the year then ended".
 */
import { describe, expect, it } from 'vitest';
import {
  getAccountingOfficerReport, getAuditReport, getCompilationReport, getDirectorsReport, getReviewReport,
  type ReportTemplateContext,
} from '@/modules/accounting/services/afs/reportTemplates';

const base: ReportTemplateContext = {
  companyName: 'Synthetic (Pty) Ltd', registrationNumber: null, periodEnd: '2027-02-28', periodStart: '2026-01-01',
  framework: 'ifrs_smes', entityType: 'pty',
};
const text = (lines: string[]) => lines.join('\n');

describe('twelve months (the default)', () => {
  it.each([
    ['compilation', getCompilationReport(base)],
    ['review', getReviewReport(base)],
    ['audit', getAuditReport(base)],
  ])('%s report says "for the year then ended"', (_name, lines) => {
    expect(text(lines)).toContain('for the year then ended');
    expect(text(lines)).not.toContain('months');
  });

  it('accounting officer and directors reports say "year ended <end>"', () => {
    expect(text(getAccountingOfficerReport({ ...base, entityType: 'cc' }))).toContain('for the year ended 2027-02-28');
    expect(text(getDirectorsReport(base))).toContain('for the year ended 2027-02-28');
  });
});

describe('a 14-month transition year', () => {
  const ctx = { ...base, periodMonths: 14 };

  it.each([
    ['compilation', getCompilationReport(ctx)],
    ['review', getReviewReport(ctx)],
    ['audit', getAuditReport(ctx)],
  ])('%s report says "for the period then ended", never "year then ended"', (_name, lines) => {
    expect(text(lines)).toContain('for the period then ended');
    expect(text(lines)).not.toContain('year then ended');
  });

  it('accounting officer and directors reports say "14 months ended <end>"', () => {
    expect(text(getAccountingOfficerReport({ ...ctx, entityType: 'cc' }))).toContain('for the 14 months ended 2027-02-28');
    expect(text(getAccountingOfficerReport({ ...ctx, entityType: 'cc' }))).not.toContain('year ended');
    expect(text(getDirectorsReport(ctx))).toContain('for the 14 months ended 2027-02-28');
    expect(text(getDirectorsReport(ctx))).not.toContain('year ended');
  });
});
