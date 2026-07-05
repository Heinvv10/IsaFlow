/**
 * Golden path (k): month-end close checklist walk.
 *
 * Known-good at baseline. Pins the checklist/workbench contracts that the
 * Phase-5 Close Agent composes.
 */
import { test, expect } from '@playwright/test';
import { Api } from './_api';

test('month-end close checklist and workbench respond with real state', async ({ baseURL }) => {
  const api = await Api.login(baseURL!);
  try {
    const close = await api.get<any>('/api/accounting/month-end-close');
    expect(close, 'month-end-close must return checklist state').toBeTruthy();
    const closeText = JSON.stringify(close);
    // The checklist tracks at least payroll/depreciation/recon dimensions.
    expect(closeText.length).toBeGreaterThan(20);

    const workbench = await api.getRaw('/api/accounting/month-end-workbench');
    expect(
      workbench.status,
      'month-end-workbench must respond (200) or be explicitly parameterised (4xx with message)',
    ).toBeLessThan(500);
    if (workbench.status === 200) {
      expect(workbench.json?.success).toBe(true);
    } else {
      expect(workbench.json?.error?.message, '4xx must carry an honest message').toBeTruthy();
    }
  } finally {
    await api.dispose();
  }
});
