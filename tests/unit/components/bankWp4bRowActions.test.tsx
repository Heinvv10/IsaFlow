/**
 * WP4b row actions: a New row shows Accept plus a "⋯" menu (More actions) holding the rest, so the Actions column is
 * narrow. What carries state stays on the row where it can be seen (a link chip, a paperclip with files, an open client
 * query). Exclude is the menu's last item and never next to Ask client. Every row target is at least 24px.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BankTxTable } from '@/components/accounting/BankTxTable';
import { rowLabels } from '@/components/accounting/bankTx/bankTxRowLabel';
import { TXS, tableProps } from './bankTxTableFixture';

afterEach(cleanup);
const label = (id: string) => rowLabels(TXS).get(id)!;
const row = (id: string) => screen.getByRole('button', { name: `Accept, ${label(id)}` }).closest('tr')!;
const menuOf = (id: string) => within(row(id)).getByRole('button', { name: `More actions, ${label(id)}` });
const openMenu = (id: string) => { fireEvent.click(menuOf(id)); return screen.getByRole('menu'); };

describe('New-row actions: Accept and a ⋯ menu', () => {
  it('the row itself shows only Accept and the menu when nothing carries state', () => {
    render(<BankTxTable {...tableProps()} />);
    const actionsCell = row('a').lastElementChild as HTMLElement;
    const names = within(actionsCell).getAllByRole('button').map(b => b.getAttribute('aria-label'));
    expect(names).toEqual([`Accept, ${label('a')}`, `More actions, ${label('a')}`]);
  });

  it('the menu holds the other actions; Exclude is last and not next to Ask client', () => {
    render(<BankTxTable {...tableProps()} />);
    const items = within(openMenu('a')).getAllByRole('menuitem').map(i => i.textContent);
    expect(items).toEqual(['Ask client on WhatsApp', 'Find & Match', 'Split transaction', 'Create rule from this transaction',
      'Link to asset / fuel / service', 'Attachments', 'Exclude']);
    expect(Math.abs(items.indexOf('Exclude') - items.indexOf('Ask client on WhatsApp'))).toBeGreaterThan(1);
  });

  it('each menu item calls its handler for that row', () => {
    const props = tableProps();
    render(<BankTxTable {...props} />);
    const calls: [string, () => unknown][] = [
      ['Exclude', () => expect(props.onExclude).toHaveBeenCalledWith('a')],
      ['Split transaction', () => expect(props.onSplit).toHaveBeenCalledWith('a')],
      ['Find & Match', () => expect(props.onFindMatch).toHaveBeenCalledWith('a')],
      ['Ask client on WhatsApp', () => expect(props.onAskClient).toHaveBeenCalledWith('a')],
      ['Attachments', () => expect(props.onAttachments).toHaveBeenCalledWith('a')],
      ['Link to asset / fuel / service', () => expect(props.onLink).toHaveBeenCalledWith(TXS[0])],
      ['Create rule from this transaction', () => expect(props.onCreateRule).toHaveBeenCalledWith(TXS[0])],
    ];
    for (const [name, check] of calls) {
      fireEvent.click(within(openMenu('a')).getByRole('menuitem', { name }));
      check();
    }
  });

  it('state stays visible on the row: files, a link, an open query', () => {
    const txs = TXS.map(t => (t.id === 'a' ? { ...t, attachmentCount: 2, queried: true, link: { kind: 'asset' as const, id: 'as1', label: 'Truck 1' } } : t));
    render(<BankTxTable {...tableProps({ transactions: txs })} />);
    const r = row('a');
    expect(within(r).getByRole('button', { name: `2 attachments - view, ${label('a')}` })).toBeInTheDocument();
    expect(within(r).getByRole('button', { name: `Client already asked on WhatsApp, ${label('a')}` })).toBeInTheDocument();
    expect(within(r).getByRole('button', { name: `Linked to Truck 1, ${label('a')}` })).toBeInTheDocument();
    const items = within(openMenu('a')).getAllByRole('menuitem').map(i => i.textContent);
    expect(items).toEqual(['Find & Match', 'Split transaction', 'Create rule from this transaction', 'Exclude']);
  });

  it('Accept and the menu trigger are at least 24px (min-h-6 min-w-6 on desktop)', () => {
    render(<BankTxTable {...tableProps()} />);
    for (const el of [screen.getByRole('button', { name: `Accept, ${label('a')}` }), menuOf('a')]) {
      expect(el.className.split(/\s+/)).toEqual(expect.arrayContaining(['min-h-6', 'min-w-6']));
    }
  });
});
