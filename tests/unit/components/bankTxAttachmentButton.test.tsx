/**
 * A bank line that has attachments says so on its paperclip: coloured, with the count, and named "N attachment(s) -
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
  it('highlights a new row that has attachments, with the count, and calls back with the row id', () => {
    const props = tableProps({ transactions: withCounts({ a: 2, n: 1 }) });
    render(<BankTxTable {...props} />);
    const two = screen.getByRole('button', { name: `2 attachments - view, ${label('a')}` });
    expect(within(two).getByText('2')).toBeTruthy();
    expect(two.className).toContain('text-blue-400');
    expect(screen.getByRole('button', { name: `1 attachment - view, ${label('n')}` })).toBeTruthy();
    fireEvent.click(two);
    expect(props.onAttachments).toHaveBeenCalledWith('a');
  });

  it('leaves a row without attachments plain and unnumbered', () => {
    render(<BankTxTable {...tableProps({ transactions: withCounts({}) })} />);
    const plain = screen.getByRole('button', { name: `Attachments, ${label('a')}` });
    expect(plain.className).not.toContain('text-blue-400');
    expect(plain.textContent).toBe('');
  });

  it('highlights reviewed rows the same way', () => {
    render(<BankTxTable {...tableProps({ tab: 'reviewed', transactions: withCounts({ d: 3, e: 1 }) })} />);
    expect(screen.getByRole('button', { name: `3 attachments - view, ${label('d')}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `1 attachment - view, ${label('e')}` })).toBeTruthy();
  });
});
