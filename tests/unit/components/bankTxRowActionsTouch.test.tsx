/** Every action on a bank card is a 44px target below lg (mobile audit, bank grid), and the icon row wraps instead of overflowing. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BankTxRowActions } from '@/components/accounting/bankTx/BankTxRowActions';
import type { BankTx, BankTxTableProps } from '@/components/accounting/bankTx/bankTxTypes';

afterEach(cleanup);

const fn = vi.fn();
const table = {
  onAccept: fn, onExclude: fn, onUnmatch: fn, onSplit: fn, onFindMatch: fn, onReverse: fn,
  onAttachments: fn, onAskClient: fn, onCreateRule: fn, onLink: fn,
} as unknown as BankTxTableProps;
const tx = { id: 't1', status: 'imported', amount: -100, attachmentCount: 0 } as unknown as BankTx;

describe('BankTxRowActions touch targets', () => {
  it('gives each action button 44px below lg and wraps the row', () => {
    const { container } = render(
      <table><tbody><tr>
        <BankTxRowActions tx={tx} label="row" sel={{ entityId: 'e' } as never} isNew isAllocated={false} isExcluded={false} table={table} />
      </tr></tbody></table>,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(8);
    for (const b of buttons) {
      expect(b.className.split(/\s+/)).toEqual(expect.arrayContaining(['max-lg:h-11', 'max-lg:w-11']));
    }
    expect(container.querySelector('td > div')?.className).toContain('max-lg:flex-wrap');
  });
});
