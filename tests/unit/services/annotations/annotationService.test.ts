/**
 * The tenant boundary on annotations, pinned at the query the service actually
 * issues rather than at its return value: a missing `company_id` predicate is
 * invisible in a mocked result set but plain in the captured SQL and its
 * bindings.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  listAnnotations, createAnnotation, resolveAnnotation, MAX_BODY_CHARS, MAX_ROW_IDS,
} from '@/modules/accounting/services/annotations/annotationService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';

const DB_ROW = {
  id: ID, row_id: 'acc:4000', period_start: new Date('2026-03-01T00:00:00Z'),
  period_end: '2026-08-31', body: 'note', author: 'u1', author_name: 'A',
  created_at: new Date('2026-09-01T00:00:00Z'), resolved_at: null,
};

const queryText = () => (sqlMock.mock.calls[0]![0] as TemplateStringsArray).join('');
const bindings = () => sqlMock.mock.calls[0]!.slice(1);

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockResolvedValue([DB_ROW]);
});

describe('listAnnotations', () => {
  it('scopes the read to the caller company', async () => {
    await listAnnotations(COMPANY, ['acc:4000'], '2026-03-01', '2026-08-31');

    expect(queryText()).toContain('company_id = ');
    expect(bindings()).toContain(COMPANY);
    expect(bindings()).not.toContain(OTHER);
  });

  it('filters on the row ids and the exact period', async () => {
    await listAnnotations(COMPANY, ['acc:4000', 'total:grossProfit'], '2026-03-01', '2026-08-31');

    expect(queryText()).toContain('row_id = ANY(');
    expect(bindings()).toContainEqual(['acc:4000', 'total:grossProfit']);
    expect(bindings()).toContain('2026-03-01');
    expect(bindings()).toContain('2026-08-31');
  });

  it('issues no query at all for an empty row list', async () => {
    expect(await listAnnotations(COMPANY, [], '2026-03-01', '2026-08-31')).toEqual([]);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('bounds the row ids it will read in one query', async () => {
    const many = Array.from({ length: MAX_ROW_IDS + 50 }, (_, i) => `acc:${i}`);
    await listAnnotations(COMPANY, many, '2026-03-01', '2026-08-31');

    expect((bindings()[1] as string[]).length).toBe(MAX_ROW_IDS);
  });

  it('maps a Date period column and a string one to the same ISO day', async () => {
    const [row] = await listAnnotations(COMPANY, ['acc:4000'], '2026-03-01', '2026-08-31');

    expect(row!.periodStart).toBe('2026-03-01');
    expect(row!.periodEnd).toBe('2026-08-31');
    expect(row!.resolvedAt).toBeNull();
  });
});

describe('createAnnotation', () => {
  it('writes under the caller company and the authenticated author', async () => {
    await createAnnotation({
      companyId: COMPANY, userId: 'u1', authorName: 'A', rowId: 'acc:4000',
      periodStart: '2026-03-01', periodEnd: '2026-08-31', body: 'note',
    });

    expect(queryText()).toContain('INSERT INTO report_annotations');
    expect(bindings()).toContain(COMPANY);
    expect(bindings()).toContain('u1');
  });

  it('truncates a body past the cap rather than rejecting it', async () => {
    await createAnnotation({
      companyId: COMPANY, userId: 'u1', authorName: null, rowId: 'acc:4000',
      periodStart: '2026-03-01', periodEnd: '2026-08-31', body: 'x'.repeat(MAX_BODY_CHARS + 100),
    });

    const written = bindings().find(b => typeof b === 'string' && b.startsWith('xxx')) as string;
    expect(written.length).toBe(MAX_BODY_CHARS);
  });
});

describe('resolveAnnotation', () => {
  it('scopes the update to the caller company and to an open row', async () => {
    expect(await resolveAnnotation(COMPANY, ID, 'u2')).toBe(true);

    expect(queryText()).toContain('company_id = ');
    expect(queryText()).toContain('resolved_at IS NULL');
    expect(bindings()).toContain(COMPANY);
    expect(bindings()).toContain(ID);
  });

  it('returns false when nothing matched, so the route answers 404', async () => {
    sqlMock.mockResolvedValue([]);
    expect(await resolveAnnotation(COMPANY, ID, 'u2')).toBe(false);
  });
});
