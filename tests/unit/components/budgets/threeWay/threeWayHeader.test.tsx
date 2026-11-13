/**
 * The three-way header's chips (budgets P6 spec §8, §13.9): the opening as-at chip turns amber when the opening
 * is provisional (as-at after today → today), "Balances ✓" turns red when ANY month's check (or the opening's)
 * is not 0, and the engine's warnings are listed in words.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThreeWayHeader } from '@/components/accounting/budgets/threeWay/ThreeWayHeader';
import { threeWayView, version, V1, V2 } from './fixtures';

afterEach(() => cleanup());

const versions = [version(), version({ id: V2, name: 'Worst', kind: 'scenario', isPrimary: false, basedOnVersionId: V1 })];
const renderHeader = (view = threeWayView(), onSelect = vi.fn()) =>
  render(<ThreeWayHeader view={view} versions={versions} selectedId={V1} onSelect={onSelect} disabled={false} />);

describe('opening as-at chip', () => {
  it('names the as-at date, neutral when the opening is final', () => {
    renderHeader();
    const chip = screen.getByTestId('opening-chip');
    expect(chip.textContent).toContain('2026-02-28');
    expect(chip.getAttribute('data-tone')).toBe('neutral');
  });

  it('amber, and says provisional, when the opening is provisional', () => {
    renderHeader(threeWayView({ provisional: true }));
    const chip = screen.getByTestId('opening-chip');
    expect(chip.getAttribute('data-tone')).toBe('amber');
    expect(chip.textContent).toMatch(/provisional/i);
  });

  it('its title shows posted vs derived retained earnings', () => {
    renderHeader();
    expect(screen.getByTestId('opening-chip').getAttribute('title')).toMatch(/derived retained earnings R\s?0/i);
  });
});

describe('Balances chip', () => {
  it('"Balances ✓" when every check is 0', () => {
    renderHeader();
    const chip = screen.getByTestId('balances-chip');
    expect(chip.textContent).toBe('Balances ✓');
    expect(chip.getAttribute('data-tone')).toBe('ok');
  });

  it('red, naming the month, when the server reports an unbalanced month', () => {
    const v = threeWayView();
    v.checks = { ...v.checks, balanced: false, unbalancedMonths: ['2026-04'] };
    v.balanceSheet[1]!.sections.check = 1;
    renderHeader(v);
    const chip = screen.getByTestId('balances-chip');
    expect(chip.getAttribute('data-tone')).toBe('red');
    expect(chip.textContent).toContain('2026-04');
  });

  it('red when a month check ≠ 0 even if the summary flag says balanced', () => {
    const v = threeWayView();
    v.balanceSheet[2]!.sections.check = -3;
    renderHeader(v);
    expect(screen.getByTestId('balances-chip').getAttribute('data-tone')).toBe('red');
    expect(screen.getByTestId('balances-chip').textContent).toContain('2026-05');
  });

  it('red when the opening check ≠ 0', () => {
    const v = threeWayView();
    v.opening.balanceSheet = { ...v.opening.balanceSheet, check: 2 };
    renderHeader(v);
    expect(screen.getByTestId('balances-chip').getAttribute('data-tone')).toBe('red');
  });
});

describe('version switcher and warnings', () => {
  it('lists the versions and switches', () => {
    const onSelect = vi.fn();
    renderHeader(threeWayView(), onSelect);
    fireEvent.change(screen.getByLabelText('Budget version'), { target: { value: V2 } });
    expect(onSelect).toHaveBeenCalledWith(V2);
  });

  it('lists the warnings in words', () => {
    const v = threeWayView();
    v.warnings = [{ code: 'negative_cash', months: ['2026-04'] }, { code: 'opening_cash_difference', differenceCents: 500, accounts: ['1010'] }];
    renderHeader(v);
    const list = screen.getByTestId('three-way-warnings');
    expect(list.textContent).toMatch(/cash below zero in 2026-04/i);
    expect(list.textContent).toMatch(/1010/);
  });
});
