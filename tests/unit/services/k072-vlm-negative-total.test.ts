/**
 * A credit note the model reports NEGATIVE is stored as a credit note.
 *
 * The round-15 review traced the last unrefused credit to `parseVlmResponse`:
 * the model's totals were stored with their sign, and round 15 relied on that
 * sign surviving all the way to `isCreditNote`'s `(totalAmount ?? 0) < 0`. It
 * does survive — but a negative total also reaches the journal builders, where
 * it posts a purchase backwards rather than refusing, and every screen that
 * shows the capture displays a negative payable. The sign is a
 * CLASSIFICATION, so it is converted into one, once, at the point of parsing:
 * the document becomes a `credit_note` and its figures are stored positive.
 * The credit refusal is kept — by the type now, not by the sign.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { extractWithVlm } from '@/modules/accounting/services/bank/vlmInvoiceService';
import { isCreditNote } from '@/modules/accounting/services/core/unattendedPostingGate';

const reply = (doc: Record<string, unknown>) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify(doc) } }] }),
});

const BASE = {
  documentType: 'invoice', vendorName: 'Acme Supplies', date: '2026-09-01',
  subtotal: -100, vatAmount: -15, totalAmount: -115, lineItems: [],
};

describe('K-072 a negative VLM total', () => {
  beforeEach(() => {
    process.env.VLLM_BASE_URL = 'http://vlm.test';
    process.env.VLLM_MODEL = 'test-model';
    process.env.VLLM_API_KEY = 'test-key';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VLLM_BASE_URL;
    delete process.env.VLLM_MODEL;
    delete process.env.VLLM_API_KEY;
  });

  it('is stored as a positive-figured credit note', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(BASE)));
    const doc = await extractWithVlm('AAAA', 'image/png', 'Widget 100.00\nTOTAL 115.00');
    expect(doc).not.toBeNull();
    expect(doc!.documentType).toBe('credit_note');
    expect(doc!.totalAmount).toBe(115);
    expect(doc!.subtotal).toBe(100);
    expect(doc!.vatAmount).toBe(15);
    expect(isCreditNote(doc!)).toBe(true);
  });

  it('leaves an ordinary positive invoice exactly as the model reported it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ ...BASE, subtotal: 100, vatAmount: 15, totalAmount: 115 })));
    const doc = await extractWithVlm('AAAA', 'image/png', 'Widget 100.00\nTOTAL 115.00');
    expect(doc!.documentType).toBe('invoice');
    expect(doc!.totalAmount).toBe(115);
    expect(isCreditNote(doc!)).toBe(false);
  });

  it('a negative SUBTOTAL alone is enough to classify it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ ...BASE, subtotal: -100, vatAmount: null, totalAmount: null })));
    const doc = await extractWithVlm('AAAA', 'image/png', '');
    expect(doc!.documentType).toBe('credit_note');
    expect(doc!.subtotal).toBe(100);
    expect(doc!.vatAmount).toBeNull();
    expect(doc!.totalAmount).toBeNull();
  });
});
