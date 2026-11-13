/**
 * /api/accounting/record-comments (M14): the write roles only, Login-as refused, rate limited, errors mapped.
 * withAuth/CSRF/error-handler are bypassed; the REAL withWriteAccess, apiResponse and impersonation response run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

type H = (req: NextApiRequest, res: NextApiResponse) => unknown;
vi.mock('@/lib/auth', async () => ({
  withAuth: (h: H) => h,
  withWriteAccess: (await vi.importActual<typeof import('@/lib/auth/withWriteAccess')>('@/lib/auth/withWriteAccess')).withWriteAccess,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: H) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: H) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/comments/recordCommentService', () => ({
  createComment: vi.fn(async () => ({ id: 'c1' })), editComment: vi.fn(async () => ({ id: 'c1' })),
  deleteComment: vi.fn(async () => undefined), listComments: vi.fn(async () => ({ comments: [], mentionable: [] })),
}));

import { checkRateLimit } from '@/lib/rateLimit';
import { ImpersonationForbiddenError } from '@/lib/auth/impersonationGuard';
import { CommentError } from '@/modules/accounting/services/comments/commentText';
import { createComment, deleteComment, editComment, listComments } from '@/modules/accounting/services/comments/recordCommentService';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/
import handler from '../../../pages/api/accounting/record-comments';

const ID = '11111111-1111-4111-8111-111111111111';
function run(method: string, role: string, extra: Record<string, unknown> = {}) {
  const out = { status: 0, body: undefined as { error?: { code?: string; details?: { reason?: string } } } | undefined };
  const res = {
    status(s: number) { out.status = s; return res; },
    json(b: typeof out.body) { out.body = b; return res; },
    setHeader: vi.fn(), end: vi.fn(),
  };
  const req = { method, companyId: 'co1', companyRole: role, user: { id: 'u1' }, query: {}, body: {}, ...extra };
  return Promise.resolve((handler as H)(req as unknown as NextApiRequest, res as unknown as NextApiResponse)).then(() => out);
}
const POST = { body: { recordType: 'customer_invoice', recordId: ID, body: 'hello' } };

beforeEach(() => { vi.clearAllMocks(); vi.mocked(checkRateLimit).mockResolvedValue(true); });

describe('who may write', () => {
  it.each(['owner', 'admin', 'manager'])('%s posts a comment', async (role) => {
    expect((await run('POST', role, POST)).status).toBe(201);
    expect(createComment).toHaveBeenCalledWith('co1', 'u1', 'customer_invoice', ID, 'hello', undefined);
  });
  it.each(['viewer', 'storeman', 'technician'])('%s is refused (403) and nothing is written', async (role) => {
    expect((await run('POST', role, POST)).status).toBe(403);
    expect((await run('PUT', role, { query: { id: ID }, body: { body: 'x' } })).status).toBe(403);
    expect((await run('DELETE', role, { query: { id: ID } })).status).toBe(403);
    expect(createComment).not.toHaveBeenCalled();
    expect(editComment).not.toHaveBeenCalled();
    expect(deleteComment).not.toHaveBeenCalled();
  });
  it('a viewer may read the thread', async () => {
    const out = await run('GET', 'viewer', { query: { recordType: 'bank_transaction', recordId: ID } });
    expect(out.status).toBe(200);
    expect(listComments).toHaveBeenCalledWith('co1', 'u1', 'bank_transaction', ID);
  });
});

describe('refusals', () => {
  it('Login-as is a 403 IMPERSONATION_FORBIDDEN', async () => {
    vi.mocked(createComment).mockRejectedValueOnce(new ImpersonationForbiddenError());
    const out = await run('POST', 'owner', POST);
    expect(out.status).toBe(403);
    expect(JSON.stringify(out.body)).toContain('IMPERSONATION_FORBIDDEN');
  });
  it('the rate limit is a 429 before the service is called', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce(false);
    expect((await run('POST', 'owner', POST)).status).toBe(429);
    expect(createComment).not.toHaveBeenCalled();
  });
  it('maps the service errors: 404, 403, 400', async () => {
    vi.mocked(createComment).mockRejectedValueOnce(new CommentError(404, 'Record not found'));
    expect((await run('POST', 'owner', POST)).status).toBe(404);
    vi.mocked(editComment).mockRejectedValueOnce(new CommentError(403, 'not yours'));
    expect((await run('PUT', 'owner', { query: { id: ID }, body: { body: 'x' } })).status).toBe(403);
    vi.mocked(deleteComment).mockRejectedValueOnce(new CommentError(400, 'bad'));
    expect((await run('DELETE', 'owner', { query: { id: ID } })).status).toBe(400);
  });
  it('rejects a bad record type, a bad id and unknown fields (422/400) without calling the service', async () => {
    expect((await run('POST', 'owner', { body: { recordType: 'journal', recordId: ID, body: 'x' } })).status).toBe(422);
    expect((await run('POST', 'owner', { body: { ...POST.body, companyId: 'other' } })).status).toBe(422);
    expect((await run('PUT', 'owner', { query: { id: 'nope' }, body: { body: 'x' } })).status).toBe(400);
    expect(createComment).not.toHaveBeenCalled();
    expect(editComment).not.toHaveBeenCalled();
  });
  it('an unexpected error is not swallowed', async () => {
    vi.mocked(createComment).mockRejectedValueOnce(new Error('boom'));
    await expect(run('POST', 'owner', POST)).rejects.toThrow('boom');
  });
});
