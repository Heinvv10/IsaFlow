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

import { loggableRequestBody, loggableUrl, sanitizeRequestBody as sanitizeBody } from '@/lib/sanitizeRequestBody';

describe('sanitizeBody — pay', () => {
  it('a new employee\'s salary is not logged next to their name', () => {
    const out = sanitizeBody({ firstName: 'Thandi', salary: { componentId: 'c1', amount: 2500000 } }) as Record<string, unknown>;
    expect(out).toEqual({ firstName: 'Thandi', salary: '[omitted]' });
  });

  it('a tax number, a birth date and medical aid details are not logged next to a name, in either spelling', () => {
    const out = sanitizeBody({
      firstName: 'Thandi', taxNumber: '0123456789', dateOfBirth: '1980-01-01', medicalAidMainMember: true, medicalAidDependantsCount: 2,
      employee_tax_number: '0123456789',
      row: { tax_number: '0123456789', date_of_birth: '1980-01-01', medical_aid_main_member: false, medical_aid_dependants_count: 0 },
    }) as Record<string, unknown>;
    expect(out).toEqual({
      firstName: 'Thandi', taxNumber: '[omitted: 10 chars]', dateOfBirth: '[omitted: 10 chars]',
      medicalAidMainMember: '[omitted]', medicalAidDependantsCount: '[omitted]', employee_tax_number: '[omitted: 10 chars]',
      row: {
        tax_number: '[omitted: 10 chars]', date_of_birth: '[omitted: 10 chars]',
        medical_aid_main_member: '[omitted]', medical_aid_dependants_count: '[omitted]',
      },
    });
  });

  it('a route can name its own pay keys, at any depth; other routes keep theirs', () => {
    const masked = new Set(['amount', 'value']);
    const body = { componentId: 'c1', amount: 25000, lines: [{ employeeId: 'e1', value: 3100.5, notes: 'x' }] };
    expect(sanitizeBody(body, 0, masked)).toEqual({
      componentId: 'c1', amount: '[omitted]', lines: [{ employeeId: 'e1', value: '[omitted]', notes: 'x' }],
    });
    expect(sanitizeBody(body)).toEqual(body);
  });
});

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

  // Security review of K1: every non-GET body reaches journald through withErrorHandler's request log.
  it.each(['accountNumber', 'account_number', 'bankAccountNumber', 'bank_account_number'])('redacts %s, at any depth', (key) => {
    const account = '62000123456';
    const out = sanitizeBody({ bankName: 'FNB', [key]: account, nested: { rows: [{ [key]: account }] } });
    expect((out as Record<string, unknown>)[key]).toBe('[REDACTED]');
    expect((out as Record<string, unknown>).bankName).toBe('FNB');
    expect(JSON.stringify(out)).not.toContain(account);
  });

  // Review of K1: an exact key list misses a client's own spelling of the field.
  it.each(['AccountNumber', 'ACCOUNT_NUMBER', 'account-number', 'account_no', 'accountNo', 'bank_account_no', 'employeeAccountNumber', 'account_number_2',
    'Account Number', 'account.number', 'account no', '$accountNumber', 'employee_account_no', 'acc_no', 'acct-num', 'bankAccNo', 'ACCOUNTNO', 'account_nr'])(
    'redacts %s, however it is cased or separated', (key) => {
      const out = sanitizeBody({ [key]: '62000123456', nested: [{ [key]: '62000123456' }] });
      expect((out as Record<string, unknown>)[key]).toBe('[REDACTED]');
      expect(JSON.stringify(out)).not.toContain('62000123456');
    });

  it('matches every listed key and fragment normalised, and leaves near misses alone', () => {
    const out = sanitizeBody({
      'api-key': 'a', 'api key': 'd', 'api.key': 'e', Client_Secret: 'b', 'ACCESS-TOKEN': 'c',
      account_id: 'keep', account_notes: 'keep', accountName: 'keep', accountNotes: 'keep', account_nominal: 'keep', accounting_no: 'keep',
    }) as Record<string, unknown>;
    expect(out).toEqual({
      'api-key': '[REDACTED]', 'api key': '[REDACTED]', 'api.key': '[REDACTED]', Client_Secret: '[REDACTED]', 'ACCESS-TOKEN': '[REDACTED]',
      account_id: 'keep', account_notes: 'keep', accountName: 'keep', accountNotes: 'keep', account_nominal: 'keep', accounting_no: 'keep',
    });
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
  it.each(['IDNumber', 'id-number', 'ID Number', 'ID_NUMBER', 'FileData', 'logo-data'])('%s is replaced by a marker, however it is spelt', (key) => {
    expect(sanitizeBody({ [key]: 'SYNTH-ID-9', nested: [{ [key]: 'SYNTH-ID-9' }] }))
      .toEqual({ [key]: '[omitted: 10 chars]', nested: [{ [key]: '[omitted: 10 chars]' }] });
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

describe('sanitizeBody — long strings', () => {
  it('logs any string longer than 1 024 characters as its length, under any key and at any depth', () => {
    const huge = 'x'.repeat(14 * 1024 * 1024);
    const out = sanitizeBody({
      x: huge, note: 'short', nested: { deeper: [{ blob: 'y'.repeat(1025) }] }, edge: 'z'.repeat(1024),
    }) as Record<string, any>;
    expect(out.x).toBe(`[omitted: ${huge.length} chars]`);
    expect(out.note).toBe('short');
    expect(out.nested).toEqual({ deeper: [{ blob: '[omitted: 1025 chars]' }] });
    expect(out.edge).toBe('z'.repeat(1024));
  });
});

describe('sanitizeBody — wide objects', () => {
  it('logs an object of more than 200 keys as its key count, at any depth; 200 or fewer are kept (and scrubbed)', () => {
    const wide = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    const out = sanitizeBody({ top: 'kept', many: wide(201), nested: { inner: wide(5000) }, some: { ...wide(199), token: 't' } }) as Record<string, any>;
    expect(out.top).toBe('kept');
    expect(out.many).toBe('[omitted: 201 keys]');
    expect(out.nested).toEqual({ inner: '[omitted: 5000 keys]' });
    expect(Object.keys(out.some)).toHaveLength(200);
    expect(out.some.token).toBe('[REDACTED]');
    expect(sanitizeBody(wide(201))).toBe('[omitted: 201 keys]');
  });
});

describe('loggableRequestBody — only a JSON object is logged', () => {
  const account = '62000123456';
  const json = { 'content-type': 'application/json' };

  it.each(['application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON'])('%s: scrubbed and logged', (type) => {
    expect(loggableRequestBody({ headers: { 'content-type': type }, body: { bankName: 'FNB', accountNumber: account } }))
      .toEqual({ bankName: 'FNB', accountNumber: '[REDACTED]' });
  });

  it.each([
    ['text/plain', 'text/plain', JSON.stringify({ accountNumber: account })],
    ['no content type', undefined, JSON.stringify({ accountNumber: account })],
    ['a form body with the JSON as its key', 'application/x-www-form-urlencoded', { [JSON.stringify({ accountNumber: account })]: '' }],
    ['a form body whose key is the bare number', 'application/x-www-form-urlencoded', { [account]: '' }],
    ['a form body with ordinary fields', 'application/x-www-form-urlencoded', { note: account }],
    ['an object with no JSON content type', undefined, { note: account }],
    ['a JSON array', 'application/json', [account]],
    ['a JSON string', 'application/json', account],
    ['a JSON number', 'application/json', Number(account)],
    ['application/ld+json', 'application/ld+json', { note: account }],
  ])('%s: omitted outright', (_name, type, body) => {
    const headers = type ? { 'content-type': type } : {};
    expect(loggableRequestBody({ headers, body })).toBe('[omitted: not a JSON object]');
  });

  it.each([[undefined], [null], ['']])('no body at all (%s) logs as none', (body) => {
    expect(loggableRequestBody({ headers: json, body })).toBeUndefined();
    expect(loggableRequestBody({ headers: {}, body })).toBeUndefined();
  });
});

describe('loggableRequestBody — a route that names what may be logged', () => {
  const body = { grant_type: 'authorization_code', client_id: 'c1', code: 'oac_secret', client_secret: 'cls', resource: ['https://a'] };
  const fields = ['grant_type', 'client_id', 'redirect_uri', 'resource'];

  it.each(['application/json', 'application/x-www-form-urlencoded', undefined])('%s: those keys and no others', (type) => {
    const headers = type ? { 'content-type': type } : {};
    expect(loggableRequestBody({ headers, body }, fields)).toEqual({ grant_type: 'authorization_code', client_id: 'c1', resource: ['https://a'] });
  });

  it('a body that is not an object is still omitted', () => {
    expect(loggableRequestBody({ headers: {}, body: 'code=oac_secret' }, fields)).toBe('[omitted: not a JSON object]');
  });
});

describe('loggableUrl — a query string gets the body\'s checks', () => {
  it.each([
    ['/api/x?accountNumber=62000123456&page=2', '/api/x?accountNumber=[REDACTED]&page=2'],
    ['/api/x?account_no=620&page=2', '/api/x?account_no=[REDACTED]&page=2'],
    ['/api/x?idNumber=8001&page=2', '/api/x?idNumber=[REDACTED]&page=2'],
    ['/api/x?password=hunter2', '/api/x?password=[REDACTED]'],
    ['/api/x?62000123456&page=2', '/api/x?[omitted]&page=2'],
    ['/api/x?62000123456=1&page=2', '/api/x?[omitted]&page=2'],
    ['/api/x?account%5Fnumber=620', '/api/x?account%5Fnumber=[REDACTED]'],
    ['/api/x?a=1&b=2', '/api/x?a=1&b=2'],
    ['/api/x?share_token=[token]&page=2', '/api/x?share_token=[token]&page=2'],
    ['/api/62000123456/x', '/api/62000123456/x'],
    ['', ''],
  ])('%s', (url, expected) => {
    expect(loggableUrl(url)).toBe(expected);
  });
});

describe('sanitizeBody — keys that may be the data itself', () => {
  const body = JSON.stringify({ bankName: 'FNB', accountNumber: '62000123456' });

  it('a top-level string is never logged, however short', () => {
    expect(sanitizeBody(body)).toBe(`[omitted: ${body.length} chars]`);
    expect(sanitizeBody('hello')).toBe('[omitted: 5 chars]');
  });

  it('a string under a key is still logged', () => {
    expect(sanitizeBody({ note: 'hello', rows: ['a'] })).toEqual({ note: 'hello', rows: ['a'] });
  });

  it.each([
    ['a whole JSON text as a key', { [body]: '' }],
    ['a short one, under the length cap', { '{"accountNumber":"62000123456"}': '' }],
    ['a bare number', { 62000123456: 'x' }],
    ['a run of 6, the shortest account', { 620001: 'x' }],
    ['digits split by spaces', { '6200 0123 456': 'x' }],
    ['digits split by dashes', { '620-001-23456': 'x' }],
    ['a run inside a name', { employee62000123456: 'x' }],
    ['a sensitive key holding one, which would keep its key', { accountNumber62000123456: 'x' }],
    ['full-width digits', { '６２００１２３': 'x' }],
    ['a key of 65 characters', { [`x${'y'.repeat(64)}`]: 'v' }],
    ['at depth', { rows: [{ 62000123456: '' }] }],
  ])('%s: the key is not logged', (_name, input) => {
    const out = JSON.stringify(sanitizeBody(input));
    expect(out).not.toMatch(/\d{6}|６２００|yyyy/);
    expect(out).toContain('[omitted keys]');
  });

  it('keeps an ordinary key of 64 characters and a short digit run, and counts what it left out', () => {
    const key = 'k'.repeat(64);
    expect(sanitizeBody({ [key]: 1, 'Account Name': 2, 'customer.name': 3, aging_bucket1_days: 4, code12345: 5, [`${key}k`]: 6, 123456: 7 }))
      .toEqual({ [key]: 1, 'Account Name': 2, 'customer.name': 3, aging_bucket1_days: 4, code12345: 5, '[omitted keys]': 2 });
  });
});
