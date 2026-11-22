// Exchange rates panel: the history table becomes labelled cards below lg; the set-rate and converter controls are 44px on phones.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExchangeRatesPanel } from '../../../src/components/accounting/currencies/ExchangeRatesPanel';
import type { ExchangeRate } from '../../../src/modules/accounting/services/core/currencyService';

afterEach(cleanup);
const currencies = [
  { code: 'ZAR', name: 'Rand', symbol: 'R', decimalPlaces: 2, isActive: true },
  { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2, isActive: true },
];
const rates = [{ id: 'r1', fromCurrency: 'USD', toCurrency: 'ZAR', rate: 18.5, effectiveDate: '2026-11-01', source: 'manual' }] as unknown as ExchangeRate[];
const HEADS = ['Pair', 'Rate', 'Effective', 'Source'];

describe('Exchange rates panel on touch', () => {
  it('turns the history table into labelled cards; the pair cell heads the card', () => {
    const { container } = render(<ExchangeRatesPanel currencies={currencies} exchangeRates={rates} onRefresh={vi.fn()} />);
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(HEADS);
    const row = table.querySelector(':scope > tbody > tr')!;
    expect([...row.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'))).toEqual([null, ...HEADS.slice(1)]); // labels equal the headers; Pair heads the card
  });

  it('makes every select, number input and button of the set-rate form and the converter 44px', () => {
    const { container } = render(<ExchangeRatesPanel currencies={currencies} exchangeRates={rates} onRefresh={vi.fn()} />);
    const fields = [...container.querySelectorAll('select, input[type=number]')];
    expect(fields).toHaveLength(6); // from, to, rate; amount, from, to
    for (const f of fields) expect(f.className, f.outerHTML.slice(0, 60)).toContain('max-lg:min-h-11');
    for (const name of [/Save Rate/, /Convert/]) expect(screen.getByRole('button', { name }).className, String(name)).toContain('max-lg:min-h-11');
  });
});
