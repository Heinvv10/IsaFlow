/** Every action on a bank card is a 44px target below lg (mobile audit, bank grid), and the icon row wraps instead of overflowing. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Select } from '@/components/ui/Select';
import { BankTxAttachmentButton } from '@/components/accounting/bankTx/BankTxAttachmentButton';
import { BankTxLinkAction } from '@/components/accounting/bank-transactions/BankTxLinkAction';
import { TOUCH_ICON, TOUCH_MIN, TOUCH_PAD, TOUCH_ROW } from '@/components/accounting/bankTx/bankTxTouch';
import { BankTxTable } from '@/components/accounting/BankTxTable';
import { rowLabel } from '@/components/accounting/bankTx/bankTxRowLabel';
import { TXS, tableProps } from './bankTxTableFixture';
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
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b.className.split(/\s+/)).toEqual(expect.arrayContaining(['max-lg:h-11', 'max-lg:w-11']));
    }
    expect(container.querySelector('td > div')?.className).toContain('max-lg:flex-wrap');
  });

  it('gives the attachment and link buttons 44px, empty and filled', () => {
    render(<><BankTxAttachmentButton txId="t" count={0} rowName="r" onOpen={fn} /><BankTxAttachmentButton txId="t" count={2} rowName="r" onOpen={fn} />
      <BankTxLinkAction rowName="r" onOpen={fn} /><BankTxLinkAction link={{ label: 'Truck' } as never} rowName="r" onOpen={fn} /></>);
    const [a0, a2, l0, l1] = screen.getAllByRole('button');
    for (const b of [a0, a2, l0]) expect(b.className).toContain('max-lg:h-11');
    expect(l1.className).toContain('max-lg:min-h-11');
  });

  it('keeps the shared touch classes at 44px', () => {
    expect(TOUCH_ICON).toContain('max-lg:h-11');
    expect(TOUCH_ROW).toContain('max-lg:min-h-11');
    expect(TOUCH_MIN).toBe('max-lg:min-h-11');
    // Truncating text keeps `block` (a flex box drops the ellipsis), so it is padded: 16px line + 2 x 14px = 44px.
    expect(TOUCH_PAD).toBe('max-lg:py-3.5');
  });
});

describe('kit Select touchTarget', () => {
  const options = [{ value: 'a', label: 'A' }];
  it('is 44px below lg only when asked, and the default stays as it was', () => {
    const { rerender } = render(<Select label="L" size="sm" options={options} value={null} onChange={() => undefined} />);
    expect(screen.getByRole('combobox').className).not.toContain('max-lg:min-h-11');
    rerender(<Select label="L" size="sm" touchTarget options={options} value={null} onChange={() => undefined} />);
    expect(screen.getByRole('combobox').className).toContain('max-lg:min-h-11');
  });
});

describe('BankTxTable cards', () => {
  it('gives the row checkbox, notes, details, selection and select cells 44px below lg', () => {
    render(<BankTxTable {...tableProps()} />);
    const label = rowLabel(TXS.find((t) => t.id === 'a')!);
    const has = (el: HTMLElement, cls: string) => expect(el.className).toContain(cls);
    has(screen.getByRole('checkbox', { name: `Select ${label}` }).closest('label') as HTMLElement, 'max-lg:h-11');
    for (const name of ['Allocation type', 'VAT']) has(screen.getByRole('combobox', { name: `${name}, ${label}` }), 'max-lg:min-h-11');
    has(screen.getByRole('button', { name: new RegExp(`^(Add note|Note), ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }), 'max-lg:py-3.5');
  });
});
