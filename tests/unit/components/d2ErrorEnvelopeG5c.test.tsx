/**
 * D2 round (currencies / exchange rates): the API error envelope is `{ success:false, error:{ code, message } }`.
 * These forms read `json.message`, or swallowed the message in a generic catch. Each test answers with the REAL
 * envelope (4xx) and, for the kept `success === false` guard, a 200 carrying it, and asserts the unique
 * message reaches the notify toast.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const { notify } = vi.hoisted(() => ({
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/utils/toast', () => ({ notify }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { CurrencyList } from '@/components/accounting/currencies/CurrencyList';
import { ExchangeRatesPanel } from '@/components/accounting/currencies/ExchangeRatesPanel';
import { AddRateForm, ConverterWidget } from '@/components/accounting/exchangeRates/ExchangeRateForms';

void mockedApiFetchModule;
useApiJsonOverMock();

const refuse = (status: number, message: string) =>
  new Response(JSON.stringify({ success: false, error: { code: 'X', message } }), { status });
const refuseOn200 = (message: string) =>
  new Response(JSON.stringify({ success: false, error: { message } }), { status: 200 });

const CURRENCIES = [
  { code: 'ZAR', name: 'Rand', symbol: 'R' },
  { code: 'USD', name: 'US Dollar', symbol: '$' },
];
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });

describe('CurrencyList add', () => {
  const add = (res: () => Response) => {
    vi.mocked(apiFetch).mockImplementation(async () => res());
    render(<CurrencyList currencies={CURRENCIES as never} reportingCurrency="ZAR" onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /add currency/i }));
    type(screen.getByPlaceholderText('USD'), 'EUR');
    type(screen.getByPlaceholderText('US Dollar'), 'Euro');
    type(screen.getByPlaceholderText('$'), 'E');
    fireEvent.click(screen.getByRole('button', { name: /save currency/i }));
  };

  it('a 4xx envelope reaches the toast', async () => {
    const m = 'D2 server says no: currency EUR already exists 5101';
    add(() => refuse(409, m));
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(m));
  });

  it('a 200 with success:false reaches the toast', async () => {
    const m = 'D2 server says no: currency refused on a 200 5102';
    add(() => refuseOn200(m));
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(m));
  });
});

describe('ExchangeRatesPanel', () => {
  const panel = (res: () => Response) => {
    vi.mocked(apiFetch).mockImplementation(async () => res());
    render(<ExchangeRatesPanel currencies={CURRENCIES as never} exchangeRates={[]} onRefresh={vi.fn()} />);
  };
  const save = () => {
    type(screen.getByPlaceholderText('e.g. 18.50'), '18.5');
    fireEvent.click(screen.getByRole('button', { name: /save rate/i }));
  };
  const convert = () => {
    type(screen.getByPlaceholderText('100'), '50');
    fireEvent.click(screen.getByRole('button', { name: /^convert$/i }));
  };

  it('save rate: a 4xx envelope reaches the toast', async () => {
    const m = 'D2 server says no: rate is more than 20 percent off yesterday 5201';
    panel(() => refuse(422, m));
    save();
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(m));
  });

  it('save rate: a 200 with success:false reaches the toast', async () => {
    const m = 'D2 server says no: rate refused on a 200 5202';
    panel(() => refuseOn200(m));
    save();
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(m));
  });

  it('convert: a 4xx envelope reaches the toast', async () => {
    const m = 'D2 server says no: no USD to ZAR rate before this date 5203';
    panel(() => refuse(404, m));
    convert();
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(m));
  });

  it('convert: a 200 with success:false reaches the toast', async () => {
    const m = 'D2 server says no: conversion refused on a 200 5204';
    panel(() => refuseOn200(m));
    convert();
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(m));
  });
});

describe('ExchangeRateForms', () => {
  const addRate = (res: () => Response) => {
    vi.mocked(apiFetch).mockImplementation(async () => res());
    render(<AddRateForm currencies={CURRENCIES} onAdded={vi.fn()} />);
    type(screen.getAllByRole('combobox')[0]!, 'USD');
    type(screen.getByPlaceholderText('e.g. 18.523400'), '18.5');
    fireEvent.click(screen.getByRole('button', { name: /add rate/i }));
  };
  const convert = (res: () => Response) => {
    vi.mocked(apiFetch).mockImplementation(async () => res());
    render(<ConverterWidget currencies={CURRENCIES} />);
    type(screen.getByPlaceholderText('1000'), '50');
    type(screen.getAllByRole('combobox')[0]!, 'USD');
    fireEvent.click(screen.getByRole('button', { name: /^convert$/i }));
  };

  it('add rate: a 4xx envelope reaches the toast', async () => {
    const m = 'D2 server says no: a rate already exists for that date 6101';
    addRate(() => refuse(409, m));
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(m));
  });

  it('add rate: a 200 with success:false reaches the toast', async () => {
    const m = 'D2 server says no: add refused on a 200 6102';
    addRate(() => refuseOn200(m));
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(m));
  });

  it('converter: a 4xx envelope reaches the toast', async () => {
    const m = 'D2 server says no: no rate on or before that date 6103';
    convert(() => refuse(404, m));
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(m));
  });

  it('converter: a 200 with success:false reaches the toast', async () => {
    const m = 'D2 server says no: conversion refused on a 200 6104';
    convert(() => refuseOn200(m));
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(m));
  });
});

describe('success paths (200 envelope { success:true, data })', () => {
  const okJson = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

  it('success: CurrencyList add completes', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => okJson({}));
    const onRefresh = vi.fn();
    render(<CurrencyList currencies={CURRENCIES as never} reportingCurrency="ZAR" onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: /add currency/i }));
    type(screen.getByPlaceholderText('USD'), 'EUR');
    type(screen.getByPlaceholderText('US Dollar'), 'Euro');
    type(screen.getByPlaceholderText('$'), 'E');
    fireEvent.click(screen.getByRole('button', { name: /save currency/i }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(notify.success).toHaveBeenCalledWith('Currency EUR created');
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('success: ExchangeRatesPanel renders the data it received and save rate completes', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      okJson(String(url).includes('convert=true') ? { converted: 912.34, rate: 17.3141 } : {}));
    const onRefresh = vi.fn();
    render(<ExchangeRatesPanel currencies={CURRENCIES as never} exchangeRates={[]} onRefresh={onRefresh} />);
    type(screen.getByPlaceholderText('100'), '50');
    fireEvent.click(screen.getByRole('button', { name: /^convert$/i }));
    expect(await screen.findByText(/17\.3141/)).toBeTruthy();
    type(screen.getByPlaceholderText('e.g. 18.50'), '18.5');
    fireEvent.click(screen.getByRole('button', { name: /save rate/i }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('success: AddRateForm completes', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => okJson({}));
    const onAdded = vi.fn();
    render(<AddRateForm currencies={CURRENCIES} onAdded={onAdded} />);
    type(screen.getAllByRole('combobox')[0]!, 'USD');
    type(screen.getByPlaceholderText('e.g. 18.523400'), '18.5');
    fireEvent.click(screen.getByRole('button', { name: /add rate/i }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('success: ConverterWidget renders the data it received', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => okJson({ result: 912.34, rate: 17.314155, effectiveDate: '2026-09-30' }));
    render(<ConverterWidget currencies={CURRENCIES} />);
    type(screen.getByPlaceholderText('1000'), '50');
    type(screen.getAllByRole('combobox')[0]!, 'USD');
    fireEvent.click(screen.getByRole('button', { name: /^convert$/i }));
    expect(await screen.findByText(/17\.314155 on 2026-09-30/)).toBeTruthy();
  });
});
