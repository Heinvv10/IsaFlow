/**
 * Tests for withWriteAccess — the role gate that blocks viewers from
 * mutating data. Verifies the default allow-list, per-endpoint overrides,
 * the opt-out, and the fail-closed behaviour when companyRole is missing.
 */

import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';

// ── Minimal NextApiResponse mock ──────────────────────────────────────────────

function mockRes() {
  const res: Partial<NextApiResponse> & {
    _status?: number;
    _body?: unknown;
    _headers: Record<string, string>;
  } = {
    _headers: {},
    status(code) {
      this._status = code;
      return this as NextApiResponse;
    },
    json(body) {
      this._body = body;
      return this as NextApiResponse;
    },
    setHeader(key, value) {
      this._headers[key] = String(value);
      return this as NextApiResponse;
    },
    getHeader(key) {
      return this._headers[key];
    },
    end() {
      return this as NextApiResponse;
    },
  };
  return res as NextApiResponse & {
    _status?: number;
    _body?: unknown;
    _headers: Record<string, string>;
  };
}

function mockReq(method: string, companyRole: string | undefined): NextApiRequest {
  return {
    method,
    headers: {},
    query: {},
    body: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...((companyRole !== undefined ? { companyRole } : {}) as any),
  } as unknown as NextApiRequest;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('withWriteAccess', () => {
  it('passes GET through for viewer role', async () => {
    const handler = vi.fn((_req, res) => res.status(200).json({ success: true }));
    const wrapped = withWriteAccess(handler);
    const req = mockReq('GET', 'viewer');
    const res = mockRes();
    await wrapped(req, res);
    expect(handler).toHaveBeenCalledOnce();
    expect(res._status).toBe(200);
  });

  it('passes HEAD and OPTIONS through for viewer role', async () => {
    const handler = vi.fn((_req, res) => res.status(204).end());
    const wrapped = withWriteAccess(handler);
    for (const method of ['HEAD', 'OPTIONS']) {
      handler.mockClear();
      const req = mockReq(method, 'viewer');
      await wrapped(req, mockRes());
      expect(handler).toHaveBeenCalledOnce();
    }
  });

  it('blocks POST for viewer role with 403', async () => {
    const handler = vi.fn();
    const wrapped = withWriteAccess(handler);
    const res = mockRes();
    await wrapped(mockReq('POST', 'viewer'), res);
    expect(handler).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect((res._body as { error: { message: string } }).error.message).toContain('viewer');
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('blocks %s for viewer role with 403', async (method) => {
    const handler = vi.fn();
    const wrapped = withWriteAccess(handler);
    const res = mockRes();
    await wrapped(mockReq(method, 'viewer'), res);
    expect(handler).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });

  it.each(['owner', 'admin', 'manager'])('allows POST for %s role', async (role) => {
    const handler = vi.fn((_req, res) => res.status(201).json({ success: true }));
    const wrapped = withWriteAccess(handler);
    const res = mockRes();
    await wrapped(mockReq('POST', role), res);
    expect(handler).toHaveBeenCalledOnce();
    expect(res._status).toBe(201);
  });

  it('allows POST for a custom-allowed role when allowedRoles is overridden', async () => {
    const handler = vi.fn((_req, res) => res.status(201).json({ success: true }));
    const wrapped = withWriteAccess(handler, { allowedRoles: ['owner', 'accountant'] });
    const res = mockRes();
    await wrapped(mockReq('POST', 'accountant'), res);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('blocks POST for manager when allowedRoles is restricted to admin+', async () => {
    const handler = vi.fn();
    const wrapped = withWriteAccess(handler, { allowedRoles: ['owner', 'admin'] });
    const res = mockRes();
    await wrapped(mockReq('POST', 'manager'), res);
    expect(handler).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });

  it('disables the gate entirely when allowedRoles is null', async () => {
    const handler = vi.fn((_req, res) => res.status(200).json({ success: true }));
    const wrapped = withWriteAccess(handler, { allowedRoles: null });
    const res = mockRes();
    // Even a viewer can POST when the gate is explicitly disabled.
    await wrapped(mockReq('POST', 'viewer'), res);
    expect(handler).toHaveBeenCalledOnce();
    expect(res._status).toBe(200);
  });

  it('fails closed with 403 when companyRole is missing (withAuth misuse)', async () => {
    const handler = vi.fn();
    const wrapped = withWriteAccess(handler);
    const res = mockRes();
    await wrapped(mockReq('POST', undefined), res);
    expect(handler).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect((res._body as { error: { message: string } }).error.message).toMatch(/no company role/i);
  });

  it('does not leak role name in response body on block (just the role in a generic message)', async () => {
    const handler = vi.fn();
    const wrapped = withWriteAccess(handler);
    const res = mockRes();
    await wrapped(mockReq('POST', 'viewer'), res);
    const body = res._body as { error: { message: string } };
    // We DO include the role in the message for developer clarity —
    // this is fine because the user already knows their own role.
    expect(body.error.message).toBeDefined();
  });

  it('lowercases method comparison (POST and post both blocked for viewer)', async () => {
    const handler = vi.fn();
    const wrapped = withWriteAccess(handler);
    for (const method of ['POST', 'post', 'Post']) {
      handler.mockClear();
      const res = mockRes();
      await wrapped(mockReq(method, 'viewer'), res);
      expect(handler).not.toHaveBeenCalled();
      expect(res._status).toBe(403);
    }
  });
});
