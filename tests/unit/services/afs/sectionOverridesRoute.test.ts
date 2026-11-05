/**
 * PUT .../sections/<id>/overrides: the body is the shape the renderers read (title a string; blocks known
 * paragraph / heading / list / table blocks; cells string, number or null; row kinds the four known ones),
 * and anything else is a 400 that names the field. Nothing is written for a refused body.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const m = vi.hoisted(() => ({ sql: vi.fn(), apiResponse: { validationError: vi.fn(), zodValidationError: vi.fn(), success: vi.fn(), methodNotAllowed: vi.fn(), notFound: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/withWriteAccess', () => ({ withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/apiResponse', () => ({ apiResponse: m.apiResponse, ErrorCode: { CONFLICT: 'CONFLICT' } }));
vi.mock('@/modules/accounting/services/afs/afsReviewService', () => ({ assertDocumentEditable: vi.fn(), ReviewError: class extends Error {} }));
vi.mock('@/modules/accounting/services/afs/afsVersionHistoryService', () => ({ saveVersion: vi.fn(async () => ({})), VersionHistoryError: class extends Error {} }));
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/
import handler from '../../../../pages/api/accounting/afs/[documentId]/sections/[sectionId]/overrides';

const call = async (overrides: unknown, extraBody: Record<string, unknown> = {}) => {
  const req = { method: 'PUT', query: { documentId: '33333333-3333-4333-8333-333333333333', sectionId: '44444444-4444-4444-8444-444444444444' }, body: { overrides, ...extraBody }, companyId: 'c', user: { id: 'u' } } as unknown as NextApiRequest;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as NextApiResponse;
  await (handler as unknown as (a: NextApiRequest, b: NextApiResponse) => Promise<void>)(req, res);
};
const refused = () => (m.apiResponse.validationError.mock.calls[0]?.[1] ?? {}) as Record<string, string[]>;

beforeEach(() => { vi.clearAllMocks(); m.sql.mockResolvedValue([{ id: 's' }]); });

describe('a body the renderers can print is accepted and written', () => {
  it.each([
    ['title and every block kind', { title: 'Income Statement (restated)', blocks: [
      { type: 'paragraph', text: 'p' }, { type: 'heading', text: 'h', level: 2 }, { type: 'list', items: ['a', 2] },
      { type: 'table', headers: ['', 'A', 1], rows: [['x', 42, null], ['y', 'R 1.00', 3]], rowKinds: ['heading', 'total'] },
    ] }],
    ['an empty object', {}],
    ['a title only', { title: 'T' }],
    ["note 26's nil-events confirmation (read by complianceCheckerService)", { suppressReason: 'nil' }],
  ])('%s', async (_n, overrides) => {
    await call(overrides);
    expect(m.apiResponse.validationError).not.toHaveBeenCalled();
    expect(m.sql).toHaveBeenCalled();
  });
});

describe('anything else is refused with the field named, and nothing is written', () => {
  it.each([
    ['a numeric title', { title: 123 }, 'overrides.title'],
    ['an object title', { title: { en: 'x' } }, 'overrides.title'],
    ['blocks that is not an array', { blocks: 'x' }, 'overrides.blocks'],
    ['a null block', { blocks: [null] }, 'overrides.blocks.0'],
    ['a block of unknown type', { blocks: [{ type: 'chart', text: 'x' }] }, 'overrides.blocks.0.type'],
    ['a paragraph with no string text', { blocks: [{ type: 'paragraph', text: null }] }, 'overrides.blocks.0.text'],
    ['an object table cell', { blocks: [{ type: 'table', headers: ['A'], rows: [['x', { v: 1 }]] }] }, 'overrides.blocks.0.rows.0.1'],
    ['a row that is not an array', { blocks: [{ type: 'table', headers: ['A'], rows: ['bad'] }] }, 'overrides.blocks.0.rows.0'],
    ['a bad row kind', { blocks: [{ type: 'table', headers: ['A'], rows: [['x']], rowKinds: ['total', 'x"><img>'] }] }, 'overrides.blocks.0.rowKinds.1'],
    ['an unknown key on a block', { blocks: [{ type: 'paragraph', text: 'x', onclick: 'y' }] }, 'overrides.blocks.0.onclick'],
    ['an unknown key on the overrides', { title: 'T', extra: 1 }, 'overrides.extra'],
    ['a suppressReason that is not nil', { suppressReason: 'x' }, 'overrides.suppressReason'],
  ])('%s', async (_n, overrides, field) => {
    await call(overrides);
    expect(Object.keys(refused())).toContain(field);
    expect(m.apiResponse.validationError.mock.calls[0]?.[2]).toContain(field);
    expect(m.sql).not.toHaveBeenCalled();
  });

  it('overrides that is not an object', async () => {
    await call('x');
    expect(Object.keys(refused())).toContain('overrides');
    expect(m.sql).not.toHaveBeenCalled();
  });
});
