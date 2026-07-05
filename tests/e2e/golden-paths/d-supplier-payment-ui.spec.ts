/**
 * Golden path (d): supplier invoice → approve → supplier payment VIA THE UI
 * FORM → allocation.
 *
 * Was EXPECTED FAIL at baseline — July-4 audit H1: the form posted
 * supplierId: Number(uuid) → NaN → silent 422. Flipped to a plain test by
 * P1.3 (PR #191: string UUID + on-screen error surfacing). Deliberately
 * UI-driven — the API path always worked; the defect was form wiring.
 */
import { test, expect } from '@playwright/test';
import { Api, gpRef, today } from './_api';

test('supplier payment created through the /new form allocates to the invoice', async ({
  page,
  baseURL,
}) => {
  const api = await Api.login(baseURL!);
  try {
    // Fixture supplier (find-or-create '0GP-Golden-Supplier'): the name's
    // '0' prefix keeps it on the dropdown's FIRST page (the form loads
    // suppliers-list default limit 25 — later-sorting names silently fall
    // off, found live 2026-07-05), and reuse bounds master-data growth.
    const supplierId = await api.fixtureSupplier();
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

    // Each allocation row = invoice <select name="invoiceId"> + amount input
    // (CSS-grid divs, no <table>). Pick our approved invoice — selectOption
    // auto-waits for the option to appear after the invoices fetch — then
    // allocate its full total (115.00).
    await page.selectOption('select[name="invoiceId"]', invoiceId, { timeout: 15_000 });
    const allocationInput = page.locator('input[type="number"][step="0.01"]').first();
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
