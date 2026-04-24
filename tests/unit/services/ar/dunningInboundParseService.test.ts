/**
 * Unit tests for dunningInboundParseService — PRD-06 Phase 5 follow-up.
 *
 * Covers:
 *   1.  extractMessageToken picks the [ref:UUID] marker
 *   2.  extractMessageToken falls back to any bare UUID in body_plain
 *   3.  extractMessageToken returns null when no UUID anywhere
 *   4.  inferAction picks 'paid' from "I have paid"
 *   5.  inferAction picks 'promised' from "will pay next week"
 *   6.  inferAction picks 'disputed' from "this amount is incorrect"
 *   7.  inferAction prefers 'disputed' over 'paid' ("I already paid" = dispute)
 *   8.  inferAction returns null for a bland "noted, thanks"
 *   9.  processInboundEmail with no token returns matched=false
 *   10. processInboundEmail with token + paid keyword calls recordResponse(paid)
 *   11. processInboundEmail with token but no keyword records 'silent'
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(sqlMock)),
  };
});

import {
  extractMessageToken,
  inferAction,
  processInboundEmail,
} from '@/modules/accounting/services/ar/dunningInboundParseService';
import { sql } from '@/lib/neon';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;

const TOKEN = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const OTHER_TOKEN = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extractMessageToken', () => {
  it('picks the [ref:UUID] marker', () => {
    const token = extractMessageToken({
      body_plain: `Thanks, will pay.\n[ref:${TOKEN}]`,
    });
    expect(token).toBe(TOKEN);
  });

  it('falls back to any bare UUID in body_plain', () => {
    const token = extractMessageToken({
      body_plain: `Please reference ${OTHER_TOKEN} in your records.`,
    });
    expect(token).toBe(OTHER_TOKEN);
  });

  it('returns null when no UUID anywhere', () => {
    const token = extractMessageToken({
      body_plain: 'Just a note — thanks.',
      subject: 'Re: invoice',
    });
    expect(token).toBeNull();
  });

  it('prefers ref: marker over bare UUID', () => {
    const token = extractMessageToken({
      body_plain: `Quoted: ${OTHER_TOKEN}\n[ref:${TOKEN}]\nthanks`,
    });
    expect(token).toBe(TOKEN);
  });
});

describe('inferAction', () => {
  it('picks paid from "I have paid"', () => {
    expect(inferAction({ body_plain: 'I have paid this invoice.' })).toBe('paid');
  });

  it('picks promised from "will pay next week"', () => {
    expect(inferAction({ body_plain: 'Will pay next week, apologies.' })).toBe('promised');
  });

  it('picks disputed from "this amount is incorrect"', () => {
    expect(inferAction({ body_plain: 'The amount is incorrect.' })).toBe('disputed');
  });

  it("treats 'already paid' as disputed (customer contests the balance)", () => {
    expect(
      inferAction({ subject: 'We already paid this!', body_plain: 'Paid last week.' }),
    ).toBe('disputed');
  });

  it('returns null for a bland reply', () => {
    expect(inferAction({ body_plain: 'Noted, thanks.' })).toBeNull();
  });
});

describe('processInboundEmail', () => {
  it('returns matched=false when no token in payload', async () => {
    const result = await processInboundEmail({
      body_plain: 'hello',
      subject: 'Re: invoice',
    });
    expect(result.matched).toBe(false);
    expect(result.updated).toBe(false);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('records paid when token + "just paid" in body', async () => {
    mockSql.mockResolvedValueOnce([{ id: 'send-1', company_id: 'co-1' }]);
    const result = await processInboundEmail({
      from: 'customer@acme.co.za',
      subject: 'Re: invoice',
      body_plain: `Payment made today. EFT done.\n[ref:${TOKEN}]`,
    });
    expect(result.matched).toBe(true);
    expect(result.messageToken).toBe(TOKEN);
    expect(result.inferredAction).toBe('paid');
    expect(result.updated).toBe(true);
    expect(result.sendId).toBe('send-1');
  });

  it("records 'silent' when token present but no keyword matches", async () => {
    mockSql.mockResolvedValueOnce([{ id: 'send-2', company_id: 'co-2' }]);
    const result = await processInboundEmail({
      body_plain: `Ok noted.\n[ref:${TOKEN}]`,
    });
    expect(result.matched).toBe(true);
    expect(result.inferredAction).toBeNull();
    expect(result.updated).toBe(true);
  });

  it('returns updated=false when recordResponse can\'t find an unresponded send', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await processInboundEmail({
      body_plain: `Thanks.\n[ref:${TOKEN}]`,
    });
    expect(result.matched).toBe(true);
    expect(result.updated).toBe(false);
  });
});
