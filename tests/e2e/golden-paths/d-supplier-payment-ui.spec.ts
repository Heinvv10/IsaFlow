/**
 * Golden path (d): supplier invoice → approve → supplier payment VIA THE UI
 * FORM → allocation.
 *
 * EXPECTED FAIL at baseline — July-4 audit H1: the form posts
 * supplierId: Number(uuid) → NaN → 422 "supplierId expected string", and the
 * failure is silent on screen. Deliberately UI-driven (the API path works);
 * P1.3 fixes the payload AND surfaces API errors in the form.
 */
import { test, expect } from '@playwright/test';
import { Api, gpRef, today } from './_api';

test('supplier payment created through the /new form allocates to the invoice', async ({
  page,
  baseURL,
}) => {
  test.fail(true, 'AUDIT H1 (2026-07-04): form sends Number(uuid) → silent 422 — fixed by P1.3');

  const api = await Api.login(baseURL!);
  try {
    // Fresh supplier so the form's invoice table contains exactly our invoice.
    const ref = gpRef('SUPP');
    const supplier = await api.post<any>('/api/accounting/suppliers-list', {
      name: ref,
      email: 'gp-supplier@example.test',
      payment_terms: 30,
    });
    const supplierId = supplier.id;
    expect(supplierId).toBeTruthy();

    const inv = await api.post<any>('/api/accounting/supplier-invoices', {
      supplierId,
      invoiceDate: today(),
      dueDate: today(),
      taxRate: 15,
      items: [{ description: gpRef('SIV'), quantity: 1, unitPrice: 100 }],
    });
    const invoiceId = inv.id;
    await api.post('/api/accounting/supplier-invoices-action', {
      action: 'approve',
      invoiceId,
    });

    // ── UI path (page fixture carries the shared golden session) ─────────
    await page.goto('/accounting/supplier-payments/new');
    await page.selectOption('select[name="supplierId"]', supplierId);

    // The approved invoice row loads; allocate its full total (115.00).
    // Allocation rows are CSS-grid divs (no <table>); the allocation amount
    // field is the page's only step-0.01 number input.
    const allocationInput = page.locator('input[type="number"][step="0.01"]').first();
    await allocationInput.waitFor({ state: 'visible', timeout: 15_000 });
    await allocationInput.fill('115');

    await page.getByRole('button', { name: /record|create|save|payment/i }).last().click();

    // CORRECT behavior: navigate to the created payment's page.
    await page.waitForURL(/supplier-payments\/[0-9a-f-]{36}/, { timeout: 15_000 });

    // And the allocation must exist server-side.
    const payments = await api.get<any>(
      `/api/accounting/supplier-payments?supplier_id=${supplierId}`,
    );
    const list = Array.isArray(payments) ? payments : payments.payments ?? [];
    expect(list.length, 'a supplier payment must exist for the fresh supplier').toBeGreaterThan(0);
  } finally {
    await api.dispose();
  }
});
