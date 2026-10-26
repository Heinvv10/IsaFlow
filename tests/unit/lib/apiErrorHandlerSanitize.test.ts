/**
 * Request-body log scrubber — Gate B CRIT: /api/oauth/token logged raw
 * client_secret + refresh_token because SENSITIVE_KEYS exact-matched and
 * missed those field names.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@sentry/nextjs', () => ({
  withIsolationScope: vi.fn((cb: () => unknown) => cb()),
  setTag: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  apiLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/lib/observability/requestContext', () => ({
  runWithRequestContext: vi.fn((_id: string, fn: () => unknown) => fn()),
  generateRequestId: vi.fn(() => 'req-1'),
}));
vi.mock('@/lib/observability/requestLogger', () => ({ logRequestCompleted: vi.fn() }));
vi.mock('@/lib/sentry/tags', () => ({ setTenantTags: vi.fn(), sanitizeRoute: vi.fn((r: string) => r) }));
vi.mock('@/lib/cors', () => ({ safeCorsOrigin: vi.fn(() => null) }));

import { sanitizeRequestBody as sanitizeBody } from '@/lib/sanitizeRequestBody';

describe('sanitizeBody — credential redaction', () => {
  it('redacts OAuth token-endpoint credentials that exact-matching previously missed', () => {
    const out = sanitizeBody({
      grant_type: 'refresh_token',
      client_id: 'client_abc',        // NOT secret — keep
      client_secret: 'cls_supersecret',
      refresh_token: 'ort_livetoken',
      code_verifier: 'pkce-verifier',
      access_token: 'oat_access',
    }) as Record<string, unknown>;

    expect(out.client_id).toBe('client_abc');
    expect(out.grant_type).toBe('refresh_token');
    for (const k of ['client_secret', 'refresh_token', 'code_verifier', 'access_token']) {
      expect(out[k]).toBe('[REDACTED]');
    }
  });

  it('still redacts the original sensitive keys and camelCase variants', () => {
    const out = sanitizeBody({
      password: 'p', token: 't', secret: 's', apiKey: 'a',
      clientSecret: 'cls_x', refreshToken: 'ort_x',
    }) as Record<string, unknown>;
    for (const k of ['password', 'token', 'secret', 'apiKey', 'clientSecret', 'refreshToken']) {
      expect(out[k]).toBe('[REDACTED]');
    }
  });

  it('does NOT over-redact benign fields (incl. a bare single-use "code")', () => {
    const out = sanitizeBody({
      code: 'oac_singleuse', country_code: 'ZA', currency_code: 'ZAR', invoice_number: 'INV-1',
    }) as Record<string, unknown>;
    expect(out.code).toBe('oac_singleuse'); // single-use, intentionally not redacted
    expect(out.country_code).toBe('ZA');
    expect(out.currency_code).toBe('ZAR');
    expect(out.invoice_number).toBe('INV-1');
  });
});

describe('sanitizeBody — file payloads and ID numbers (onboarding complete-setup bodies)', () => {
  it('replaces file data and ID numbers at any depth with a size marker; keeps the rest', () => {
    const pdf = `data:application/pdf;base64,${'A'.repeat(4000)}`;
    const out = sanitizeBody({
      requestKey: 'k', entityType: 'pty_ltd',
      company: { name: 'Synthetic', logoData: 'data:image/png;base64,AAAA' },
      people: [{ name: 'Person A', idNumber: 'SYNTH-ID-1', idDocument: { name: 'id.png', data: pdf } }],
      documents: [{ type: 'cipc_certificate', name: 'c.pdf', data: pdf, mimeType: 'application/pdf' }],
      rows: [{ id_number: 'SYNTH-ID-2', file_data: pdf }],
      password: 'p',
    }) as Record<string, any>;
    expect(out.entityType).toBe('pty_ltd');
    expect(out.company).toEqual({ name: 'Synthetic', logoData: '[omitted: 26 chars]' });
    expect(out.people).toEqual([{ name: 'Person A', idNumber: '[omitted: 10 chars]', idDocument: '[omitted]' }]);
    expect(out.documents).toEqual([{ type: 'cipc_certificate', name: 'c.pdf', data: `[omitted: ${pdf.length} chars]`, mimeType: 'application/pdf' }]);
    expect(out.rows).toEqual([{ id_number: '[omitted: 10 chars]', file_data: `[omitted: ${pdf.length} chars]` }]);
    expect(out.password).toBe('[REDACTED]');
    expect(JSON.stringify(out)).not.toMatch(/SYNTH-ID|AAAA/);
  });
  it('a short, non-file `data` is kept and walked (bulk rows, settings), not omitted', () => {
    const out = sanitizeBody({
      data: { rows: [{ account: '1000', amount: 5, idNumber: 'SYNTH-ID-3' }] },
      settings: { data: 'compact' },
    }) as Record<string, any>;
    expect(out.data).toEqual({ rows: [{ account: '1000', amount: 5, idNumber: '[omitted: 10 chars]' }] });
    expect(out.settings).toEqual({ data: 'compact' });
    expect((sanitizeBody({ data: 'x'.repeat(1025) }) as Record<string, string>).data).toBe('[omitted: 1025 chars]');
  });
  it('a `data` array holding files (data: URLs or long strings) is omitted; an array of rows is walked', () => {
    const out = sanitizeBody({
      a: { data: ['data:image/png;base64,AAAA', 'data:application/pdf;base64,BBBB'] },
      b: { data: ['short', 'y'.repeat(2000)] },
      c: { data: [{ account: '1000', idNumber: 'SYNTH-ID-4' }] },
    }) as Record<string, Record<string, unknown>>;
    expect(out.a!.data).toBe('[omitted: 2 items]');
    expect(out.b!.data).toBe('[omitted: 2 items]');
    expect(out.c!.data).toEqual([{ account: '1000', idNumber: '[omitted: 10 chars]' }]);
    expect(JSON.stringify(out)).not.toMatch(/AAAA|BBBB|yyyy|SYNTH-ID/);
  });
  it('a file nested anywhere under `data` (arrays in arrays, objects in arrays) omits the whole `data`', () => {
    const out = sanitizeBody({
      a: { data: [['data:image/png;base64,CCCC']] },
      b: { data: [{ name: 'scan.pdf', content: 'data:application/pdf;base64,DDDD' }] },
      c: { data: { files: { front: 'z'.repeat(1500) } } },
    }) as Record<string, Record<string, unknown>>;
    expect(out.a!.data).toBe('[omitted: 1 items]');
    expect(out.b!.data).toBe('[omitted: 1 items]');
    expect(out.c!.data).toBe('[omitted]');
    expect(JSON.stringify(out)).not.toMatch(/CCCC|DDDD|zzzz/);
  });
  it('a `data` nested past the depth cap (10 levels) is omitted, not walked: fail closed', () => {
    let deep: unknown = 'short';
    for (let i = 0; i < 10; i++) deep = { level: deep };
    expect((sanitizeBody({ data: deep }) as Record<string, unknown>).data).toBe('[omitted]');
  });
});

describe('sanitizeBody — long arrays', () => {
  it('logs an array of more than 50 items as a count, at any depth; 50 or fewer are kept (and scrubbed)', () => {
    const cell = (i: number) => ({ glAccountId: `acct-${i}`, amount: i, token: 't' });
    const out = sanitizeBody({
      versionId: 'v1',
      cells: Array.from({ length: 51 }, (_, i) => cell(i)),
      nested: { rows: Array.from({ length: 20_000 }, (_, i) => i) },
      few: Array.from({ length: 50 }, (_, i) => cell(i)),
    }) as Record<string, any>;
    expect(out.versionId).toBe('v1');
    expect(out.cells).toBe('[omitted: 51 items]');
    expect(out.nested).toEqual({ rows: '[omitted: 20000 items]' });
    expect(out.few).toHaveLength(50);
    expect(out.few[0]).toEqual({ glAccountId: 'acct-0', amount: 0, token: '[REDACTED]' });
    expect(sanitizeBody(Array.from({ length: 51 }, (_, i) => i))).toBe('[omitted: 51 items]');
  });
});
