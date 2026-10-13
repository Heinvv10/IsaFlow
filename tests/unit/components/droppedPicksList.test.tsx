/**
 * The persistent list under an imported file: every bank line whose auto-post
 * could not apply a cost centre, with its date, amount, DESCRIPTION (two R500
 * debit orders on one day must be told apart) and EVERY warning it carries.
 */
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DroppedPicksList } from '@/components/accounting/bank/DroppedPicksList';

const OLD = 'Line 1: cost centre OLD is inactive and was not applied — the line posts without it.';
const SITE = 'Line 2: project PH was not applied — it belongs to another FNO than the line\'s CC1.';
const line = (n: number, over: Record<string, unknown> = {}) => ({
  txId: `t${n}`, journalEntryId: `j${n}`, label: '2026-09-01 R 500,00', description: `DEBIT ORDER ${n}`, warnings: [OLD], ...over,
});
afterEach(() => cleanup());

describe('DroppedPicksList', () => {
  it('shows nothing when no line dropped a pick', () => {
    const { container } = render(<DroppedPicksList lines={[]} />);
    expect(container.textContent).toBe('');
  });

  it('lists each line with date, amount, description and every warning', () => {
    render(<DroppedPicksList lines={[line(1), line(2, { warnings: [OLD, SITE] })]} />);
    expect(screen.getByText('2 lines posted without their cost centre')).toBeTruthy();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // two lines, same day, same amount: told apart by description
    expect(items[0]!.textContent).toContain('2026-09-01');
    expect(items[0]!.textContent).toContain('R 500,00');
    expect(items[0]!.textContent).toContain('DEBIT ORDER 1');
    expect(items[1]!.textContent).toContain('DEBIT ORDER 2');
    expect(within(items[0]!).getAllByText(/not applied/)).toHaveLength(1);
    // the second warning of a line is not dropped
    expect(within(items[1]!).getByText('cost centre OLD not applied (inactive)')).toBeTruthy();
    expect(within(items[1]!).getByText('project PH not applied (another FNO)')).toBeTruthy();
  });

  it('a line without a description still lists, and the singular reads right', () => {
    render(<DroppedPicksList lines={[line(1, { description: null })]} />);
    expect(screen.getByText('1 line posted without its cost centre')).toBeTruthy();
    expect(screen.getAllByRole('listitem')[0]!.textContent).toContain('2026-09-01');
  });

  it('collapses a long list behind a toggle, and opens it', () => {
    render(<DroppedPicksList lines={Array.from({ length: 6 }, (_, i) => line(i + 1))} />);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /6 lines posted without their cost centre/ }));
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: /6 lines posted without their cost centre/ }));
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('clamps a long description to one row, with the full text on hover', () => {
    const long = 'DEBIT ORDER '.repeat(30).trim();
    render(<DroppedPicksList lines={[line(1, { description: long })]} />);
    const el = screen.getByTitle(long);
    expect(el.className).toMatch(/\btruncate\b/);
    expect(el.textContent).toContain('DEBIT ORDER');
  });

  it('does not throw on a line missing its pieces', () => {
    expect(() => render(<DroppedPicksList lines={[{ txId: 't', warnings: [OLD] }, { warnings: [] }]} />)).not.toThrow();
  });

  it('clamps a long label too (it must not push the row wider), with its full text on hover', () => {
    const label = 'L'.repeat(120);
    render(<DroppedPicksList lines={[line(1, { label })]} />);
    const el = screen.getByTitle(label);
    expect(el.className).toMatch(/\btruncate\b/);
    expect(el.className).toMatch(/\bmin-w-0\b/);
  });

  it('lets a long unbroken warning sentence wrap instead of widening the row', () => {
    render(<DroppedPicksList lines={[line(1, { warnings: ['Line 1: ' + 'U'.repeat(200)] })]} />);
    const el = screen.getByText('U'.repeat(200));
    expect(el.className).toMatch(/\bbreak-words\b/);
  });
});
