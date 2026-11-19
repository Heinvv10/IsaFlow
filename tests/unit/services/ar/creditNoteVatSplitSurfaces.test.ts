/**
 * The credit-note VAT split refusal (creditNoteTypedSplit) is a registered refusal: raised before any write and naming
 * only the caller's own note and invoice figures, so an MCP tool shows its sentence verbatim instead of a fallback.
 */
import { describe, expect, it } from 'vitest';
import { isRefusalCoded, safeErrorText } from '@/lib/mcp/tools/toolHelpers';
import { CreditNoteVatSplitRefusal } from '@/modules/accounting/services/ar/creditNoteTypedSplit';

describe('CreditNoteVatSplitRefusal on the MCP surface', () => {
  it('is a registered refusal whose message reaches the agent', () => {
    const err = new CreditNoteVatSplitRefusal('Credit note CN-1: 600.00 of it carries no VAT');
    expect(err.code).toBe('CREDIT_NOTE_VAT_SPLIT_REFUSED');
    expect(isRefusalCoded(err)).toBe(true);
    expect(safeErrorText(err, 'fallback')).toBe('Credit note CN-1: 600.00 of it carries no VAT');
  });
});
