/** create_credit_note refuses, before any write, a total (subtotal + VAT) NUMERIC(15,2) cannot hold, in the service's words (#1701 round 11 nit c). */
import { describe, expect, it } from 'vitest';
import { SUPPLIER, KEY, ctx, errText } from './creditNoteTools.harness';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { createCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';

describe('create_credit_note: the total in range', () => {
  it('9 999 999 999 999 at 15% is refused naming the limit; nothing created', async () => {
    const r = await createCreditNoteTool.handler({ type: 'supplier', supplier_id: SUPPLIER, credit_date: '2026-11-11', subtotal: 9_999_999_999_999, tax_rate: 15, ...KEY }, ctx());
    expect(r.isError).toBe(true);
    expect(errText(r)).toMatch(/^The credit note comes to 11499999999998\.85 with its VAT, more than an amount can hold/);
    expect(createCreditNote).not.toHaveBeenCalled();
  });
});
