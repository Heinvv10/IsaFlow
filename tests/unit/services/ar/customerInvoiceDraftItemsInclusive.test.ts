/**
 * customerInvoiceDraftItems keeps a resent line's item by matching the IDENTICAL stored line on its stored unit_price.
 * On an inclusive invoice (per-line VAT writer PR) unit_price is stored as entered, VAT-inclusive, and the edit page
 * re-sends it as entered, so an unchanged save keeps the item; the old client conversion (the ex-VAT price) would not
 * have matched the stored gross. Statement-text answers only.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));

import { resolveDraftEditItems } from '@/modules/accounting/services/ar/customerInvoiceDraftItems';

const ITEM = '44444444-4444-4444-8444-444444444444';
const tx = vi.fn(async (strings: TemplateStringsArray) => (strings.join('?').includes('FROM customer_invoice_items')
  ? [{ gl_account_id: null, project_id: null, item_id: ITEM, description: 'Widget', quantity: '100.00', unit_price: '9.99' }] : []));

describe('an inclusive line resent as entered', () => {
  it('keeps the stored line\'s item', async () => {
    const out = await resolveDraftEditItems(tx, 'co', 'inv', [{ description: 'Widget', quantity: 100, unitPrice: 9.99 }]);
    expect('items' in out && out.items[0]!.itemId).toBe(ITEM);
  });
  it('an ex-VAT conversion of the price (what the page used to send) would not match it', async () => {
    const out = await resolveDraftEditItems(tx, 'co', 'inv', [{ description: 'Widget', quantity: 100, unitPrice: 8.69 }]);
    expect('items' in out && out.items[0]!.itemId).toBeUndefined();
  });
});
