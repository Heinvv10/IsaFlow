/**
 * A bank line that has attachments says so on its paperclip: coloured, numbered from two files up, and named "N attachment(s) -
 * view" so a screen reader hears it too. A line without any keeps the plain grey "Attachments" button. Every row state
 * that draws the paperclip (new, allocated, reviewed) goes through the same button.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BankTxTable } from '@/components/accounting/BankTxTable';
import { rowLabel } from '@/components/accounting/bankTx/bankTxRowLabel';
import { TXS, tableProps } from './bankTxTableFixture';

afterEach(cleanup);

const withCounts = (counts: Record<string, number>) => TXS.map(t => ({ ...t, attachmentCount: counts[t.id] ?? 0 }));
const label = (id: string) => rowLabel(TXS.find(t => t.id === id)!);

describe('the attachment button', () => {
  it('highlights a new row that has attachments, numbers it from two files, and calls back with the row id', () => {
    const props = tableProps({ transactions: withCounts({ a: 2, n: 1 }) });
    render(<BankTxTable {...props} />);
    const two = screen.getByRole('button', { name: `2 attachments - view, ${label('a')}` });
    expect(within(two).getByText('2')).toBeTruthy();
    expect(two.className).toContain('text-blue-400');
    const one = screen.getByRole('button', { name: `1 attachment - view, ${label('n')}` });
    expect(one.className).toContain('text-blue-400');
    expect(one.textContent).toBe('');
    fireEvent.click(two);
    expect(props.onAttachments).toHaveBeenCalledWith('a');
  });

  it('leaves a row without attachments plain and unnumbered', () => {
    render(<BankTxTable {...tableProps({ transactions: withCounts({}) })} />);
    const plain = screen.getByRole('button', { name: `Attachments, ${label('a')}` });
    expect(plain.className).not.toContain('text-blue-400');
    expect(plain.textContent).toBe('');
  });

  it('caps the badge at 9+ from ten files, and keeps the full count in its name', () => {
    render(<BankTxTable {...tableProps({ transactions: withCounts({ a: 9, c: 10 }) })} />);
    expect(screen.getByRole('button', { name: `9 attachments - view, ${label('a')}` }).textContent).toBe('9');
    expect(screen.getByRole('button', { name: `10 attachments - view, ${label('c')}` }).textContent).toBe('9+');
  });

  it('shows on an excluded line and a pending line that have files, and adds nothing to one without', () => {
    const excluded = render(<BankTxTable {...tableProps({ tab: 'excluded', transactions: withCounts({ f: 2 }) })} />);
    expect(screen.getByRole('button', { name: `2 attachments - view, ${label('f')}` }).textContent).toBe('2');
    excluded.unmount();
    const none = render(<BankTxTable {...tableProps({ tab: 'excluded', transactions: withCounts({}) })} />);
    expect(screen.queryByRole('button', { name: `Attachments, ${label('f')}` })).toBeNull();
    none.unmount();
    render(<BankTxTable {...tableProps({ transactions: withCounts({ b: 1 }) })} />);
    expect(screen.getByRole('button', { name: `1 attachment - view, ${label('b')}` }).textContent).toBe('');
  });

  it('highlights reviewed rows the same way', () => {
    render(<BankTxTable {...tableProps({ tab: 'reviewed', transactions: withCounts({ d: 3, e: 1 }) })} />);
    expect(screen.getByRole('button', { name: `3 attachments - view, ${label('d')}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `1 attachment - view, ${label('e')}` })).toBeTruthy();
  });
});
