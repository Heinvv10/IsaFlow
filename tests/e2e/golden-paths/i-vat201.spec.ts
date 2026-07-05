/**
 * Golden path (i): VAT201 compute + exceptions panel.
 *
 * Known-good at baseline. Pins the VAT201 box structure (the Phase-4 SARS
 * e-filing work builds on exactly this contract) and the pre-filing
 * exceptions endpoint that gates submission.
 */
import { test, expect } from '@playwright/test';
import { Api } from './_api';

test('VAT201 computes box structure and exceptions panel responds', async ({ baseURL }) => {
  const api = await Api.login(baseURL!);
  try {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const from = `${y}-${m}-01`;
    const to = `${y}-${m}-28`;

    const vat = await api.get<any>(`/api/accounting/sars/sars-vat201?from=${from}&to=${to}`);
    // The 11 SARS boxes must all be present and numeric.
    for (const field of [
      'field1_standardRatedSupplies',
      'field2_zeroRatedSupplies',
      'field3_exemptSupplies',
      'field4_totalImports',
      'field5_outputVAT',
      'field6_capitalGoods',
      'field7_otherGoods',
      'field8_services',
      'field9_imports',
      'field10_totalInputVAT',
      'field11_vatPayableOrRefundable',
    ]) {
      expect(typeof vat[field], `${field} must be numeric`).toBe('number');
    }
    expect(vat.periodStart).toBe(from);
    expect(vat.periodEnd).toBe(to);

    // Consistency: payable = output − input (sign convention pinned here).
    expect(vat.field11_vatPayableOrRefundable).toBeCloseTo(
      vat.field5_outputVAT - vat.field10_totalInputVAT,
      2,
    );

    // Exceptions panel (the "do not file" gate) responds with a report.
    const exceptions = await api.get<any>(
      `/api/accounting/sars/vat-exceptions?from=${from}&to=${to}`,
    );
    expect(exceptions, 'exceptions endpoint must return a report object').toBeTruthy();
    expect(typeof exceptions).toBe('object');
  } finally {
    await api.dispose();
  }
});
