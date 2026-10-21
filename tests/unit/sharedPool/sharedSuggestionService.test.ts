/**
 * The scoped reader: filtered keys only, the definer lookup decides eligibility, the company's OWN mapping
 * gives the account, and a failure never breaks categorisation. SQL is mocked by statement text; the real
 * function and grants are proved in tests/integration/shared-merchant-patterns.int.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, warn } = vi.hoisted(() => ({ sqlMock: vi.fn(), warn: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } }));

import {
  getSharedSuggestion, getSharedSuggestions, SHARED_POOL_LABEL, SHARED_POOL_MIN_CONFIDENCE,
} from '@/modules/accounting/services/sharedPool/sharedSuggestionService';

const CO = '00000000-0000-4000-8000-000000000001';
const OWN_FUEL = '00000000-0000-4000-8000-0000000000f1';

type Route = { lookup?: unknown[]; mappings?: unknown[] };
function route(r: Route) {
  sqlMock.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (/shared_pool_lookup/.test(text)) return r.lookup ?? [];
    if (/FROM company_category_mappings/.test(text)) return r.mappings ?? [];
    throw new Error(`unexpected SQL: ${text}`);
  });
}
const lookupCall = () => sqlMock.mock.calls.find((c) => (c[0] as TemplateStringsArray).join('?').includes('shared_pool_lookup'));

beforeEach(() => { sqlMock.mockReset(); warn.mockReset(); process.env.MERCHANT_SHARING_ENABLED = 'true'; });
const gateBefore = process.env.MERCHANT_SHARING_ENABLED;
afterEach(() => {
  if (gateBefore === undefined) delete process.env.MERCHANT_SHARING_ENABLED; else process.env.MERCHANT_SHARING_ENABLED = gateBefore;
});

describe('getSharedSuggestions', () => {
  it('maps the pool category to the company\'s own account, labelled shared_pool', async () => {
    route({
      lookup: [{ merchant: 'ENGEN', category_code: 'fuel', confidence: '0.7500' }],
      mappings: [{ category_code: 'fuel', gl_account_id: OWN_FUEL, account_code: '6100', account_name: 'Fuel', default_vat_code: 'standard' }],
    });
    const r = await getSharedSuggestions(CO, [{ txId: 't1', description: 'POS ENGEN SANDTON 1234' }]);
    expect(r.get('t1')).toEqual({
      glAccountId: OWN_FUEL, glAccountCode: '6100', glAccountName: 'Fuel', category: 'Fuel', vatCode: 'standard',
      confidence: 0.75, confidenceLevel: 'MEDIUM', matchSource: 'shared_pool', matchDetail: SHARED_POOL_LABEL,
    });
    // The lookup is asked for the filtered key and this company only.
    expect(lookupCall()!.slice(1)).toEqual([CO, ['ENGEN']]);
  });

  it('an ineligible company (the definer answers nothing) gets nothing, and the mapping is never read', async () => {
    route({ lookup: [] });
    expect((await getSharedSuggestions(CO, [{ txId: 't1', description: 'ENGEN' }])).size).toBe(0);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('a category this company has not mapped gives no suggestion', async () => {
    route({ lookup: [{ merchant: 'ENGEN', category_code: 'fuel', confidence: 0.8 }], mappings: [] });
    expect((await getSharedSuggestions(CO, [{ txId: 't1', description: 'ENGEN' }])).size).toBe(0);
  });

  it('the account id only ever comes from this company\'s mapping read (never from the pool)', async () => {
    route({
      lookup: [{ merchant: 'ENGEN', category_code: 'fuel', confidence: 0.8, gl_account_id: 'someone-elses' }],
      mappings: [{ category_code: 'fuel', gl_account_id: OWN_FUEL, account_code: '6100', account_name: 'Fuel', default_vat_code: null }],
    });
    const r = await getSharedSuggestions(CO, [{ txId: 't1', description: 'ENGEN' }]);
    expect(r.get('t1')!.glAccountId).toBe(OWN_FUEL);
    const mappingSql = sqlMock.mock.calls.find((c) => (c[0] as TemplateStringsArray).join('?').includes('company_category_mappings'))!;
    expect(mappingSql.slice(1)).toEqual([CO, ['fuel']]);
  });

  it(`below ${SHARED_POOL_MIN_CONFIDENCE} confidence nothing is suggested`, async () => {
    route({
      lookup: [{ merchant: 'ENGEN', category_code: 'fuel', confidence: '0.5999' }, { merchant: 'SHELL', category_code: 'fuel', confidence: '0.6' }],
      mappings: [{ category_code: 'fuel', gl_account_id: OWN_FUEL, account_code: '6100', account_name: 'Fuel', default_vat_code: null }],
    });
    const r = await getSharedSuggestions(CO, [{ txId: 't1', description: 'ENGEN' }, { txId: 't2', description: 'SHELL' }]);
    expect([...r.keys()]).toEqual(['t2']);
  });

  it('a description the PII filter rejects is never looked up', async () => {
    route({});
    const r = await getSharedSuggestions(CO, [
      { txId: 't1', description: 'J SMITH' }, { txId: 't2', description: 'SALARY OCT' }, { txId: 't3', description: 'EFT 62012345678' },
    ]);
    expect(r.size).toBe(0);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('asks once per distinct merchant, and answers every line of it', async () => {
    route({
      lookup: [{ merchant: 'ENGEN', category_code: 'fuel', confidence: 0.6 }],
      mappings: [{ category_code: 'fuel', gl_account_id: OWN_FUEL, account_code: '6100', account_name: 'Fuel', default_vat_code: null }],
    });
    const r = await getSharedSuggestions(CO, [
      { txId: 't1', description: 'ENGEN A' }, { txId: 't2', description: 'ENGEN B' },
    ]);
    expect([...r.keys()]).toEqual(['t1', 't2']);
    expect(lookupCall()![2]).toEqual(['ENGEN']);
  });

  it('a failed lookup is logged and costs only the suggestion', async () => {
    sqlMock.mockRejectedValue(new Error('function shared_pool_lookup does not exist'));
    expect((await getSharedSuggestions(CO, [{ txId: 't1', description: 'ENGEN' }])).size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('getSharedSuggestion (one description)', () => {
  it('returns the suggestion or null', async () => {
    route({ lookup: [] });
    expect(await getSharedSuggestion(CO, 'ENGEN')).toBeNull();
  });
});

describe('the legal-review gate (MERCHANT_SHARING_ENABLED)', () => {
  const pooled = () => route({
    lookup: [{ merchant: 'ENGEN', category_code: 'fuel', confidence: 0.8 }],
    mappings: [{ category_code: 'fuel', gl_account_id: OWN_FUEL, account_code: '6100', account_name: 'Fuel', default_vat_code: null }],
  });
  it.each([undefined, 'false', 'TRUE', '1'])('MERCHANT_SHARING_ENABLED=%s: nothing, and no SQL (stored pool rows never served)', async (v) => {
    if (v === undefined) delete process.env.MERCHANT_SHARING_ENABLED; else process.env.MERCHANT_SHARING_ENABLED = v;
    pooled();
    expect((await getSharedSuggestions(CO, [{ txId: 't1', description: 'ENGEN' }])).size).toBe(0);
    expect(await getSharedSuggestion(CO, 'ENGEN')).toBeNull();
    expect(sqlMock).not.toHaveBeenCalled();
  });
  it("MERCHANT_SHARING_ENABLED='true': the same pool row is served", async () => {
    pooled();
    expect((await getSharedSuggestion(CO, 'ENGEN'))?.glAccountId).toBe(OWN_FUEL);
  });
});
