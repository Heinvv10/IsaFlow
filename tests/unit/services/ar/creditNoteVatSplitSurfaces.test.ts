/**
 * The credit-note VAT split refusal (creditNoteTypedSplit) is a registered refusal: raised before any write and naming
 * only the caller's own note and invoice figures, so an MCP tool shows its sentence verbatim instead of a fallback.
 */
import { describe, expect, it } from 'vitest';
import { isRefusalCoded, safeErrorText } from '@/lib/mcp/tools/toolHelpers';
import { CreditNoteVatSplitRefusal } from '@/modules/accounting/services/ar/creditNoteTypedSplit';
import { createCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotesCreate';

describe('CreditNoteVatSplitRefusal on the MCP surface', () => {
  it('is a registered refusal whose message reaches the agent', () => {
    const msg = 'Credit note CN-1 reverses 50.50 of an invoice with 101.00 left, so its VAT must be 7.60, not 7.58.';
    const err = new CreditNoteVatSplitRefusal(msg);
    expect(err.code).toBe('CREDIT_NOTE_VAT_SPLIT_REFUSED');
    expect(isRefusalCoded(err)).toBe(true);
    expect(safeErrorText(err, 'fallback')).toBe(msg);
  });

  it('create_credit_note tells the agent, before it creates one, that such a note is proportional', () => {
    expect(createCreditNoteTool.description).toContain(
      'A customer note linked to an invoice with a VAT type per line must carry that invoice\'s remaining VAT in proportion '
      + 'to the net it credits (not the rate on its subtotal); approve_credit_note refuses any other figure and states the one required.',
    );
  });
});
