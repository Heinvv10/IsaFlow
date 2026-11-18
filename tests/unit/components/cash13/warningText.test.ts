/**
 * Forecast warnings in plain English: every code the engine and readers emit has its own words, the raw code is
 * never shown, and an unknown code still reads as a sentence.
 */
import { describe, expect, it } from 'vitest';
import { cash13WarningText, KNOWN_WARNING_CODES } from '@/components/accounting/cashForecast13/cash13WarningText';

const ENGINE_CODES = [
  'beyond_horizon', 'budget_flag_off', 'budget_no_primary', 'budget_unavailable', 'credit_unused', 'currency_not_converted',
  'irp6_no_budget', 'loan_payments_not_recorded', 'manual_item_past', 'override_skipped', 'payroll_frequency_unsupported', 'payroll_no_runs',
  'payroll_past_assumed_paid', 'sars_marks_unavailable', 'sars_past_due_assumed_paid', 'sars_submissions_unavailable',
  'source_unavailable', 'vat_no_budget',
];

describe('cash13WarningText', () => {
  it('has words for every code the engine emits', () => {
    expect([...KNOWN_WARNING_CODES].sort()).toEqual([...ENGINE_CODES].sort());
  });

  it.each(ENGINE_CODES)('%s never shows its code', (code) => {
    const t = cash13WarningText({ code, source: 'payroll', message: 'plain words from the server' });
    expect(t.title).not.toMatch(/_/);
    expect(t.title.length).toBeGreaterThan(10);
    expect(`${t.title} ${t.detail ?? ''}`).not.toContain(code);
  });

  it('names what could not be read', () => {
    expect(cash13WarningText({ code: 'source_unavailable', source: 'loans', message: 'loans could not be read; the forecast leaves it out' }).title)
      .toBe('Could not read the loans: they are left out of this forecast.');
  });

  it('a skipped change says which week and why, without the line key', () => {
    const t = cash13WarningText({ code: 'override_skipped', source: 'overrides', message: 'Override on ap:5e1c week 3 skipped: the cell is empty, nothing to move' });
    expect(t.title).toBe('One of your changes (week 3) was not applied: the cell is empty, nothing to move.');
    expect(t.detail).toBeUndefined();
  });

  it('assumed-paid items keep their list as the detail', () => {
    const t = cash13WarningText({ code: 'sars_past_due_assumed_paid', source: 'sars', message: '1 SARS item(s) ... assumed paid: EMP201 due 2026-11-07 R 4 000.00' });
    expect(t.title).toMatch(/assumed paid/);
    expect(t.detail).toContain('R 4 000.00');
  });

  describe('SARS returns assumed paid', () => {
    const item = (kind: string, periodStart: string, periodEnd: string, dueDate: string, cents: number) => ({ kind, periodStart, periodEnd, dueDate, cents });
    const warn = (assumedPaid: ReturnType<typeof item>[]) => ({ code: 'sars_past_due_assumed_paid', source: 'sars', message: 'raw server list that must not show', assumedPaid });
    const nb = (s: string | undefined) => (s ?? '').replace(/\u00a0/g, ' ');

    it('many: one line with the count, the date range and the total in cents; the title\'s phrase is not repeated', () => {
      const t = cash13WarningText(warn([
        item('EMP201', '2025-12-01', '2025-12-31', '2026-01-07', -4_791_877),
        item('VAT201', '2025-11-01', '2025-12-31', '2026-01-23', -10_000_001),
        item('EMP201', '2026-09-01', '2026-09-30', '2026-11-06', -10),
      ]));
      expect(nb(t.detail)).toBe('3 returns due 7 Jan 2026 to 6 Nov 2026, R 147 918.88 in total, are not marked filed.');
      expect(t.detail).not.toMatch(/assumed paid/i);
      expect(t.detail).not.toContain('raw server list');
    });

    it('one: singular, a single date', () => {
      const t = cash13WarningText(warn([item('EMP201', '2026-09-01', '2026-09-30', '2026-10-07', -123_450)]));
      expect(nb(t.detail)).toBe('1 return due 7 Oct 2026, R 1 234.50, is not marked filed.');
    });

    it('the dates are the earliest and latest due dates, whatever the order they arrive in', () => {
      const t = cash13WarningText(warn([
        item('EMP201', '2026-02-01', '2026-02-28', '2026-03-06', -100), item('EMP201', '2026-01-01', '2026-01-31', '2026-02-06', -100),
      ]));
      expect(nb(t.detail)).toContain('due 6 Feb 2026 to 6 Mar 2026');
    });

    it('the total is exact in cents (no float drift): 0.10 + 0.20 is 0.30', () => {
      const t = cash13WarningText(warn([item('EMP201', '2026-01-01', '2026-01-31', '2026-02-06', -10), item('EMP201', '2026-02-01', '2026-02-28', '2026-03-06', -20)]));
      expect(nb(t.detail)).toContain('R 0.30 in total');
    });

    it('a refund is its own figure, never netted into the payments', () => {
      const t = cash13WarningText(warn([item('VAT201', '2026-03-01', '2026-04-30', '2026-05-25', -50_000), item('VAT201', '2026-01-01', '2026-02-28', '2026-03-25', 20_000)]));
      expect(nb(t.detail)).toBe('2 returns due 25 Mar 2026 to 25 May 2026, R 500.00 in payments and R 200.00 in refunds, are not marked filed.');
    });

    it('each return is listed for the collapsed list: type, period, due date, amount', () => {
      const t = cash13WarningText(warn([item('EMP201', '2025-12-01', '2025-12-31', '2026-01-07', -4_791_877), item('VAT201', '2026-01-01', '2026-02-28', '2026-03-25', 20_000)]));
      expect(t.items?.map(nb)).toEqual([
        'EMP201 1 Dec 2025 to 31 Dec 2025, due 7 Jan 2026: R 47 918.77',
        'VAT201 1 Jan 2026 to 28 Feb 2026, due 25 Mar 2026: R 200.00 refund',
      ]);
    });

    it('one return has no list to expand', () => {
      expect(cash13WarningText(warn([item('EMP201', '2025-12-01', '2025-12-31', '2026-01-07', -4_791_877)])).items).toBeUndefined();
    });

    it('a server without the structured items still gets its message as the detail', () => {
      const t = cash13WarningText({ code: 'sars_past_due_assumed_paid', source: 'sars', message: '1 SARS item(s) ...: EMP201 due 2026-11-07 R 4 000.00' });
      expect(t.detail).toContain('R 4 000.00');
      expect(t.items).toBeUndefined();
    });
  });

  it('past one-off items you added: what to do, and the list', () => {
    const t = cash13WarningText({ code: 'manual_item_past', source: 'manual items', message: '1 one-off manual item(s) dated before this week are not forecast; re-date or delete them: "Grant" 2026-11-02 R 2 000.00' });
    expect(t.title).toMatch(/change their date or remove them/);
    expect(t.detail).toContain('"Grant" 2026-11-02');
  });

  it('an unknown code reads as a sentence with the server\'s message', () => {
    expect(cash13WarningText({ code: 'new_thing', source: 'engine', message: 'Something new' }))
      .toEqual({ title: 'Something new.' });
  });
});
