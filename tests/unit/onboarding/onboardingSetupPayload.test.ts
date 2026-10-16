/**
 * parseSetupRequest: every check POST /api/onboarding/complete-setup makes on its body before
 * anything is written. Synthetic values; files are built to pass (or fail) fileMagic.
 */
import { describe, expect, it } from 'vitest';
import { parseSetupRequest, setupFactsOf } from '@/modules/onboarding/services/onboardingSetupPayload';

const b64 = (buf: Buffer) => buf.toString('base64');
const pdfBytes = (n = 2048) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(Math.max(0, n - 9), 0x20)]);
const pngBytes = (n = 2048) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(Math.max(0, n - 8))]);
const PDF = `data:application/pdf;base64,${b64(pdfBytes())}`;
const PNG = `data:image/png;base64,${b64(pngBytes())}`;
const doc = (type: string, over: Record<string, unknown> = {}) => ({ type, name: `${type}.pdf`, data: PDF, mimeType: 'application/pdf', ...over });
const REQUEST_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; // synthetic
const body = (over: Record<string, unknown> = {}) => ({
  requestKey: REQUEST_UUID, entityType: 'other', company: { name: 'Synthetic Trading' }, people: [], documents: [], ...over,
});
const error = (b: unknown) => { const r = parseSetupRequest(b); return r.ok ? null : r.error; };
const value = (b: unknown) => { const r = parseSetupRequest(b); if (!r.ok) throw new Error(r.error); return r.value; };

describe('shape, key, entity, template', () => {
  it('a body must be an object', () => {
    for (const b of [null, 'x', [], 5]) expect(error(b)).toBe('A JSON body is required');
  });
  it('requestKey must be a UUID; it is lower-cased', () => {
    expect(error(body({ requestKey: 'nope' }))).toBe('requestKey must be a UUID');
    expect(error(body({ requestKey: undefined }))).toBe('requestKey must be a UUID');
    expect(value(body({ requestKey: REQUEST_UUID.toUpperCase() })).requestKey).toBe(REQUEST_UUID);
  });
  it('entityType must be one of the eight codes', () => {
    expect(error(body({ entityType: 'company' }))).toBe('Choose the type of business');
  });
  it('coaTemplate defaults to isaflow_standard and must be known', () => {
    expect(value(body()).coaTemplate).toBe('isaflow_standard');
    expect(error(body({ coaTemplate: 'zoho' }))).toMatch(/^coaTemplate must be one of/);
  });
  it('people / documents must be arrays within their caps', () => {
    expect(error(body({ people: 'x' }))).toBe('people must be an array');
    expect(error(body({ documents: {} }))).toBe('documents must be an array');
    expect(error(body({ people: Array.from({ length: 51 }, (_, i) => ({ name: `P${i}` })) }))).toBe('Maximum 50 people');
    expect(error(body({ documents: Array.from({ length: 21 }, () => doc('tax_clearance')) }))).toBe('Maximum 20 documents');
  });
});

describe('company', () => {
  it('is required; the name is trimmed', () => {
    expect(error(body({ company: undefined }))).toBe('company is required');
    expect(value(body({ company: { name: '  Synthetic  ' } })).company.name).toBe('Synthetic');
  });
  it('text fields must be text of at most 500 characters', () => {
    expect(error(body({ company: { name: 'S', email: 5 } }))).toBe('company.email must be text');
    expect(error(body({ company: { name: 'S', city: 'x'.repeat(501) } }))).toBe('company.city is longer than 500 characters');
    expect(error(body({ company: { name: 'x'.repeat(501) } }))).toBe('company.name is longer than 500 characters');
    expect(value(body({ company: { name: 'S', city: 'x'.repeat(500) } })).company.city).toHaveLength(500);
  });
  it('financialYearStart is a whole month 1-12', () => {
    for (const m of [0, 13, 1.5, '3']) expect(error(body({ company: { name: 'S', financialYearStart: m } }))).toMatch(/financialYearStart/);
    expect(value(body({ company: { name: 'S', financialYearStart: 12 } })).company.financialYearStart).toBe(12);
  });
  it('the VAT pair is validated and stored normalised', () => {
    expect(error(body({ company: { name: 'S', vatPeriod: 'quarterly' } }))).toMatch(/^vatPeriod must be/);
    expect(error(body({ company: { name: 'S', vatSystemType: 'cash' } }))).toMatch(/^vatSystemType must be/);
    const c = value(body({ company: { name: 'S', vatPeriod: ' Bi-Monthly ', vatSystemType: 'INVOICE' } })).company;
    expect([c.vatPeriod, c.vatSystemType]).toEqual(['bi-monthly', 'invoice']);
  });
  it('the logo must be a raster data URL whose bytes match it', () => {
    expect(value(body({ company: { name: 'S', logoData: PNG } })).company.logoData).toBe(PNG);
    expect(error(body({ company: { name: 'S', logoData: 'data:image/svg+xml;base64,PHN2Zz4=' } }))).toMatch(/^Logo must be/);
    expect(error(body({ company: { name: 'S', logoData: `data:image/png;base64,${b64(pdfBytes())}` } })))
      .toBe('Logo file content does not match declared type');
    expect(error(body({ company: { name: 'S', logoData: `data:image/png;base64,${'A'.repeat(6_800_001)}` } }))).toMatch(/^Logo must be/);
  });
});

describe('people', () => {
  it('a blank row is dropped; names and ID numbers are trimmed', () => {
    const v = value(body({ people: [{ name: '  ' }, { name: ' Person A ', idNumber: ' SYNTH-1 ' }] }));
    expect(v.people).toEqual([{ name: 'Person A', idNumber: 'SYNTH-1', idDocument: null }]);
  });
  it('an ID document: the data-URL prefix names the type and the bytes must agree', () => {
    const ok = value(body({ people: [{ name: 'A', idDocument: { name: 'id.png', data: PNG } }] }));
    expect(ok.people[0]!.idDocument).toEqual({ name: 'id.png', data: PNG, mimeType: 'image/png' });
    expect(error(body({ people: [{ name: 'A', idDocument: { name: 'id.png', data: `data:image/png;base64,${b64(pdfBytes())}` } }] })))
      .toBe('ID document of A: contents do not match image/png');
    expect(error(body({ people: [{ name: 'A', idDocument: { name: 'id', data: b64(pdfBytes()) } }] })))
      .toBe('ID document of A: file type (missing) not allowed');
    expect(error(body({ people: [{ name: 'A', idDocument: 'x' }] }))).toBe('people[0].idDocument must be an object');
  });
  it('text caps apply to people too', () => {
    expect(error(body({ people: [{ name: 'x'.repeat(501) }] }))).toBe('people[0].name is longer than 500 characters');
    expect(error(body({ people: [{ name: 'A', idNumber: '1'.repeat(501) }] }))).toBe('people[0].idNumber is longer than 500 characters');
  });
});

describe('documents', () => {
  it('a good document is kept with its decoded size', () => {
    expect(value(body({ documents: [doc('tax_clearance')] })).documents[0]).toMatchObject({ type: 'tax_clearance', size: 2048 });
  });
  it('type is required; MIME must be allowed; data must decode', () => {
    expect(error(body({ documents: [doc('')] }))).toBe('documents[0].type is required');
    expect(error(body({ documents: [doc('x', { mimeType: 'text/html', data: b64(pdfBytes()) })] }))).toBe('Document "x.pdf": file type text/html not allowed');
    expect(error(body({ documents: [doc('x', { data: '' })] }))).toBe('Document "x.pdf": invalid or empty file data');
  });
  it('the data-URL prefix must agree with mimeType', () => {
    expect(error(body({ documents: [doc('x', { data: PNG })] }))).toBe('Document "x.pdf": the file says image/png, not application/pdf');
  });
  it('magic bytes must match; under 1 KB is refused (a 4-byte "%PDF" is not a certificate)', () => {
    expect(error(body({ documents: [doc('x', { data: `data:application/pdf;base64,${b64(Buffer.from('<html>x</html>'))}` })] })))
      .toBe('Document "x.pdf": contents do not match application/pdf');
    expect(error(body({ documents: [doc('x', { data: `data:application/pdf;base64,${b64(Buffer.from('%PDF'))}` })] })))
      .toBe('Document "x.pdf" is too small to be a real document (under 1 KB)');
    expect(error(body({ documents: [doc('x', { data: `data:application/pdf;base64,${b64(pdfBytes(1024))}` })] }))).toBeNull();
  });
  it('more than 20 MB in one file, or 30 MB in the request, is refused', () => {
    const big = (mb: number) => `data:application/pdf;base64,${b64(pdfBytes(mb * 1024 * 1024))}`;
    expect(error(body({ documents: [doc('x', { data: big(21) })] }))).toBe('Document "x.pdf" exceeds the 20 MB limit');
    expect(error(body({ documents: [doc('a', { data: big(16) }), doc('b', { data: big(16) })] })))
      .toBe('The uploaded files are larger than 30 MB together. Remove or shrink some and try again.');
  });
});

describe('setupFactsOf', () => {
  it('passes the registration number, ID numbers and ID documents to the rules', () => {
    const v = value(body({
      company: { name: 'S', registrationNumber: '2020/123456/07' },
      people: [{ name: 'A', idNumber: 'SYNTH-1', idDocument: { name: 'id.png', data: PNG } }], documents: [doc('tax_clearance')],
    }));
    expect(setupFactsOf(v)).toEqual({
      entityType: 'other', name: 'S', registrationNumber: '2020/123456/07', documentTypes: ['tax_clearance'],
      people: [{ name: 'A', hasIdDocument: true, idNumber: 'SYNTH-1', idDocumentData: PNG }],
    });
  });
});
