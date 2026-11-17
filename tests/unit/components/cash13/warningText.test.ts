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
