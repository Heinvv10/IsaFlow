/**
 * Round 32 (review of `79d3a99c7`, 1M/3L).
 *
 * MEDIUM: the MCP tools compare a draft's VAT with the VAT read off its
 * captured document (DB side: `k072-capture-vat-unread`, `k072-receipt-vat-unread`).
 * LOW-1: a legend that defines a bare token (`Z = zero rated`, `* = zero-rated
 * items`, `D = disbursement, no VAT`, `E = Exempt`) marks the priced item
 * carrying it, and a marker on a description whose price the layout split into
 * a column marks it too. The residual, re-opened: on an unpaid document the
 * arithmetic proves the tax inside only a total whose label names it payable.
 */
import { describe, expect, it } from 'vitest';
import { unreconciledFigure } from '@/modules/accounting/services/core/ocrLargerFigure';

const HDR = 'Mokoena Attorneys\nTAX INVOICE\nVAT No 4123456789\nInvoice No: 0045\nDate: 2026-09-01\n';
const BANK = 'Banking details: FNB Acc 62812345678';
const PRE = { subtotal: 1000.3, vatAmount: 150 };
const pretax = { reason: 'pretax' };
const due = (items: string, legend = '', label = 'Amount Due') =>
  `${HDR}${items}${label} 1150.30\nVAT 15% 150.00\n${legend}${legend ? '\n' : ''}${BANK}`;

describe('K-076 r32 LOW-1 — a legend defines the bare token on the item', () => {
  it.each([['Bread 150.30 Z', 'Z = zero rated'], ['Bread 150.30 *', '* = zero-rated items'],
    ['Deeds fee 150.30 D', 'D = disbursement, no VAT'], ['Deeds fee 150.30 E', 'E = Exempt'],
    ['Bread 150.30 Z', '(Z) Zero rated'], ['Bread 150.30 Z', 'Note: Z zero rated'],
    ['Deeds fee 150.30 E', 'Items marked with an E are exempt'], ['Deeds fee 150.30 V', 'Vrygestelde items gemerk V'],
    ['Bread 150.30 Z', 'Prices include VAT unless marked Z']])(
    'a pre-tax total, `%s` defined by `%s`, labelled payable: refuses', (item, legend) => {
      expect(unreconciledFigure(due(`Services 1000.00\n${item}\n`, legend), 1150.3, PRE)).toMatchObject(pretax);
    });

  it('the split-column layout: the marker, or a legend token, on a description whose price is in a later column', () => {
    const noVat = due('Conveyancing fee\nDeeds office fee (no VAT)\n1000.00\n150.30\n');
    expect(unreconciledFigure(noVat, 1150.3, PRE)).toMatchObject(pretax);
    const token = due('Conveyancing fee\nDeeds office fee D\n1000.00\n150.30\n', 'D = disbursement, no VAT');
    expect(unreconciledFigure(token, 1150.3, PRE)).toMatchObject(pretax);
  });

  it('the other direction: an honest inclusive bill whose legend token is inside words or on no item still posts', () => {
    const text = (items: string, legend: string) => `${HDR}${items}Amount Due 1150.00\nVAT 15% 150.00\n${legend}\n${BANK}`;
    const K = { subtotal: 1000, vatAmount: 150 };
    for (const legend of ['E = Exempt', 'Z = zero rated', '* = zero-rated items', 'D = disbursement, no VAT']) {
      expect(unreconciledFigure(text('EGGS DOZEN 575.00\nZUCCHINI 575.00\n', legend), 1150, K)).toBeNull();
    }
    // The legend line itself is no item, even above a price column.
    const column = `${HDR}Prices include VAT unless marked Z\nPlatters\nDrinks\n575.00\n575.00\nAmount Due 1150.00\nVAT 15% 150.00\n${BANK}`;
    expect(unreconciledFigure(column, 1150, K)).toBeNull();
    // A token run is not the token: `**` is emphasis, not `*`.
    expect(unreconciledFigure(text('**SPECIAL** Platters 1150.00\n', '* = zero-rated items'), 1150, K)).toBeNull();
  });
});

describe('K-076 r32 — the arithmetic exemption needs a payable label on an unpaid document', () => {
  const inclusive = (label: string, items = 'Labour 1000.00\n') => `${HDR}${items}${label} 1000.00\nVAT 130.43\n${BANK}`;
  const K = { subtotal: 869.57, vatAmount: 130.43 };

  it.each(['Amount Due', 'Balance Due', 'Total Due', 'AMOUNT PAYABLE', 'Total Payable', 'Totaal Verskuldig',
    'Totaal Betaalbaar'])('`%s 1000.00 / VAT 130.43` posts', (label) => {
    expect(unreconciledFigure(inclusive(label), 1000, K)).toBeNull();
  });

  // `Bedrag/Saldo Verskuldig` are not summary labels to the figure reader, so an
  // item line above them over-sums (a different rule, unchanged); alone they post.
  it.each(['Bedrag Verskuldig', 'Saldo Verskuldig', 'Bedrag Betaalbaar'])('`%s 1000.00 / VAT 130.43` posts', (label) => {
    expect(unreconciledFigure(inclusive(label, ''), 1000, K)).toBeNull();
  });

  it.each(['Total', 'TOTAL', 'Totaal', 'Invoice Total', 'Total Amount'])('`%s 1000.00 / VAT 130.43`, unpaid, refuses', (label) => {
    expect(unreconciledFigure(inclusive(label), 1000, K)).toMatchObject(pretax);
  });

  it('a total no total pattern knows is still judged where it last prints (it was exempt): an unknown label refuses', () => {
    for (const label of ['Faktuurbedrag', 'Invoice Amount', 'Grand Sum']) {
      expect(unreconciledFigure(inclusive(label, ''), 1000, K)).toMatchObject(pretax);
    }
  });

  it('the fixed fee pair a supplier prints on every invoice refuses every time, not by coincidence', () => {
    for (const [fee, disb, vat] of [[1000, 150.3, 150], [2000, 300.6, 300], [800, 120.24, 120]]) {
      const total = Math.round((fee + disb) * 100) / 100;
      const text = `${HDR}Conveyancing fee ${fee.toFixed(2)}\nDeeds office fee ${disb.toFixed(2)}\nTotal ${total.toFixed(2)}\nVAT 15% ${vat.toFixed(2)}\n${BANK}`;
      expect(unreconciledFigure(text, total, { subtotal: total - vat, vatAmount: vat })).toMatchObject(pretax);
    }
  });

  it('a paid slip with a bare TOTAL and the VAT below still posts: the tender proves the payable', () => {
    const slip = 'SPAR Linden\nTAX INVOICE\nVAT No 4130987654\nBread 115.00\nTOTAL 115.00\nCARD 115.00\nVAT 15% 15.00';
    expect(unreconciledFigure(slip, 115, { subtotal: 100, vatAmount: 15 })).toBeNull();
  });

  it('DISCLOSED RESIDUAL, pinned as open: a pre-tax figure the document itself labels `Amount Due`, no marker, still posts', () => {
    expect(unreconciledFigure(due('Conveyancing fee 1000.00\nDeeds office fee 150.30\n'), 1150.3, PRE)).toBeNull();
  });
});
