/**
 * Intercompany P5, the report's refusals ((c)): the order (own session, then the dark flag, then the intercompany write role), the query
 * (a connection UUID, a section, a page; ANY asOf parameter is a 400: there is no user-chosen date, (k).2), the fixed sentences and statuses
 * (no figure, no id, never database text), and the sentence of every withheld reason and every bucket.
 */
import { describe, expect, it } from 'vitest';
import {
  RECON_SENTENCES, RECON_STATUS, WITHHELD_SENTENCES, firstRefusal, parseReconQuery, reconRefusal, ReconRefusal,
} from '@/modules/accounting/services/intercompany/loanReconRefusals';
import { BUCKET_SENTENCES, sectionsOf } from '@/modules/accounting/services/intercompany/loanReconSections';
import { BUCKETS, MAX_RECON_OFFSET, PARTNER_STATES } from '@/modules/accounting/services/intercompany/loanReconTypes';

const CONN = 'c0000000-0000-4000-8000-000000000001';

describe('the refusal order', () => {
  it.each<[string, Parameters<typeof firstRefusal>[0], string | null]>([
    ['a Login-as session first, whatever else', { session: 'impersonation', flagOn: false, canWrite: false }, 'impersonating'],
    ['a session without a session id', { session: 'unknown', flagOn: false, canWrite: false }, 'not_own_session'],
    ['then the flag', { session: 'self', flagOn: false, canWrite: false }, 'not_enabled'],
    ['then the write role', { session: 'self', flagOn: true, canWrite: false }, 'forbidden'],
    ['none', { session: 'self', flagOn: true, canWrite: true }, null],
  ])('%s', (_n, gates, code) => {
    expect(firstRefusal(gates)).toBe(code);
  });
});

describe('parseReconQuery', () => {
  it('a connection, the defaults (attention, 50, 0), ids lower-cased', () => {
    expect(parseReconQuery({ connectionId: CONN.toUpperCase() })).toEqual({ ok: true, value: { connectionId: CONN, section: 'attention', limit: 50, offset: 0 } });
    expect(parseReconQuery({ connectionId: CONN, section: 'undone', limit: '200', offset: '50' })).toEqual({ ok: true, value: { connectionId: CONN, section: 'undone', limit: 200, offset: 50 } });
  });
  it.each<[string, Record<string, unknown>]>([
    ['no connection', {}], ['a connection that is no UUID', { connectionId: 'x' }], ['two connections', { connectionId: [CONN, CONN] }],
    ['an asOf parameter', { connectionId: CONN, asOf: '2026-01-01' }], ['an empty asOf', { connectionId: CONN, asOf: '' }],
    ['an unknown section', { connectionId: CONN, section: 'all' }], ['a limit of 0', { connectionId: CONN, limit: '0' }],
    ['a limit over 200', { connectionId: CONN, limit: '201' }], ['a fractional limit', { connectionId: CONN, limit: '1.5' }],
    ['a negative offset', { connectionId: CONN, offset: '-1' }], ['an offset as words', { connectionId: CONN, offset: 'ten' }],
    ['an offset past the capped lists (round 1, LOW-9)', { connectionId: CONN, offset: '6001' }],
    ['an offset far past them', { connectionId: CONN, offset: '900719925474099' }],
  ])('refuses %s', (_n, q) => {
    expect(parseReconQuery(q).ok).toBe(false);
  });
  it('the offset cap is the 5 000 messages plus the two capped lists: the last reachable row, no further', () => {
    expect(MAX_RECON_OFFSET).toBe(5000 + 2 * 500);
    expect(parseReconQuery({ connectionId: CONN, offset: String(MAX_RECON_OFFSET) })).toMatchObject({ ok: true, value: { offset: MAX_RECON_OFFSET } });
  });
});

describe('the sentences', () => {
  it('every code has a status and a fixed sentence that names no figure and no id', () => {
    for (const [code, sentence] of Object.entries(RECON_SENTENCES)) {
      expect(sentence, code).toMatch(/\w/);
      expect(sentence, code).not.toMatch(/\d{3,}|[0-9a-f]{8}-/i);
      expect(RECON_STATUS[code as keyof typeof RECON_STATUS], code).toBeGreaterThanOrEqual(400);
    }
    expect(RECON_SENTENCES.not_enabled).toBe('Intercompany loan reconciliation is not enabled for this company.');
    expect(RECON_STATUS).toMatchObject({ impersonating: 403, not_own_session: 403, not_enabled: 403, forbidden: 403, not_found: 404, too_many: 422, timeout: 503 });
    const r = reconRefusal('too_many');
    expect(r).toBeInstanceOf(ReconRefusal);
    expect(r).toMatchObject({ status: 422, code: 'too_many', message: RECON_SENTENCES.too_many });
  });
  it('every withheld reason and every bucket has a sentence', () => {
    for (const s of PARTNER_STATES.filter((x) => x !== 'ok')) expect(WITHHELD_SENTENCES[s], s).toMatch(/\w/);
    // the partner_setup sentence is ONE generic word for a NULL, header or shared partner account ((k).3): it names none of them
    expect(WITHHELD_SENTENCES.partner_setup).not.toMatch(/shared|header|another/i);
    for (const b of BUCKETS) expect(BUCKET_SENTENCES[b], b).toMatch(/\w/);
  });
});

describe('sections', () => {
  it('the undone list is the three undone buckets; attention takes the rest that need a person; mismatches are their own list', () => {
    const row = (bucket: (typeof BUCKETS)[number] | null, over: Partial<Parameters<typeof sectionsOf>[0]> = {}) =>
      sectionsOf({ bucket, flags: [], mismatches: [], kind: 'message', ...over });
    expect(row('payer_undone')).toEqual(['undone']);
    expect(row('receiver_undone')).toEqual(['undone']);
    expect(row('both_undone')).toEqual(['undone']);
    expect(row('matched')).toEqual([]);
    expect(row('in_flight')).toEqual([]);
    for (const b of ['not_live', 'not_through_loan', 'rejected_or_dismissed', 'withdrawn', 'anomaly', 'loan_account_changed', 'timing', 'payer_timing'] as const) {
      expect(row(b), b).toEqual(['attention']);
    }
    expect(row('in_flight', { flags: ['pending_too_long'] })).toEqual(['attention']);
    expect(row('in_flight', { flags: ['failed'], mismatches: ['currency'] })).toEqual(['attention', 'mismatch']);
    expect(row(null, { kind: 'unsent', flags: ['unsent'] })).toEqual(['attention']);
    expect(row(null)).toEqual([]);
    expect(row(null, { mismatches: ['amount'] })).toEqual(['mismatch']);
  });
});
