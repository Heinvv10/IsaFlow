// How the golden payroll specs clear a pay run's R-035 approval: a second approver when E2E_APPROVER_* is set (prod
// Demo has several eligible approvers), else the sole-approver self-approval (CI slots). Half-set must fail loudly.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api, ApiError } from '../../e2e/golden-paths/_api';
import { clearPayRunApproval, readApprover } from '../../e2e/golden-paths/helpers/payRunApproval';

const REQUEST = { id: 'req-1', documentDigest: 'dig-1' };
const DECISION = { action: 'approve', requestId: 'req-1', expectedDigest: 'dig-1' };
const URL = '/api/accounting/approval-requests';

function fakeApi(approveError?: Error) {
  const post = vi.fn(async (_path: string, body: { action: string }) => {
    if (body.action === 'approve' && approveError) throw approveError;
    return REQUEST;
  });
  const get = vi.fn(async () => ({ activeCompanyId: 'co-1' }));
  const dispose = vi.fn(async () => undefined);
  return { post, get, dispose } as unknown as Api & { post: typeof post; get: typeof get; dispose: typeof dispose };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('readApprover', () => {
  it('is null when neither is set, empty counts as unset', () => {
    expect(readApprover({})).toBeNull();
    expect(readApprover({ E2E_APPROVER_EMAIL: '', E2E_APPROVER_PASSWORD: '' })).toBeNull();
  });
  it('returns both when both are set', () => {
    expect(readApprover({ E2E_APPROVER_EMAIL: 'a@x', E2E_APPROVER_PASSWORD: 'p' })).toEqual({ email: 'a@x', password: 'p' });
  });
  it('fails loudly when exactly one is set', () => {
    expect(() => readApprover({ E2E_APPROVER_EMAIL: 'a@x' })).toThrow(/E2E_APPROVER_PASSWORD/);
    expect(() => readApprover({ E2E_APPROVER_PASSWORD: 'p' })).toThrow(/E2E_APPROVER_EMAIL/);
  });
});

describe('clearPayRunApproval', () => {
  it('self-approves with the suite user when no approver is configured', async () => {
    const api = fakeApi();
    const login = vi.spyOn(Api, 'loginAs');
    await clearPayRunApproval(api, 'http://x', 'run-1');
    expect(api.post.mock.calls.map((c) => c[1])).toEqual([
      { action: 'request', documentType: 'pay_run', documentId: 'run-1' }, DECISION,
    ]);
    expect(login).not.toHaveBeenCalled();
  });

  it('names E2E_APPROVER_* in /home/hein/isaflow-deploy.env when self-approval is forbidden', async () => {
    const forbidden = new ApiError(403, { error: { code: 'SELF_APPROVAL_FORBIDDEN' } }, 'POST', URL);
    await expect(clearPayRunApproval(fakeApi(forbidden), 'http://x', 'run-1')).rejects.toThrow(/E2E_APPROVER_EMAIL.*isaflow-deploy\.env/s);
  });

  it('does not rewrite other approve failures', async () => {
    const other = new ApiError(409, { error: { code: 'STALE_DIGEST' } }, 'POST', URL);
    await expect(clearPayRunApproval(fakeApi(other), 'http://x', 'run-1')).rejects.toBe(other);
  });

  it('with an approver: requests as the suite user, approves as the approver in the same company, disposes', async () => {
    vi.stubEnv('E2E_APPROVER_EMAIL', 'second@x');
    vi.stubEnv('E2E_APPROVER_PASSWORD', 'pw');
    const api = fakeApi();
    const second = fakeApi();
    const login = vi.spyOn(Api, 'loginAs').mockResolvedValue(second);
    await clearPayRunApproval(api, 'http://x', 'run-1');
    expect(login).toHaveBeenCalledWith('http://x', { email: 'second@x', password: 'pw', companyId: 'co-1' });
    expect(api.post.mock.calls.map((c) => (c[1] as { action: string }).action)).toEqual(['request']);
    expect(second.post).toHaveBeenCalledWith(URL, DECISION);
    expect(second.dispose).toHaveBeenCalled();
  });

  it('half-set approver fails before raising any request', async () => {
    vi.stubEnv('E2E_APPROVER_EMAIL', 'second@x');
    vi.stubEnv('E2E_APPROVER_PASSWORD', '');
    const api = fakeApi();
    await expect(clearPayRunApproval(api, 'http://x', 'run-1')).rejects.toThrow(/together/);
    expect(api.post).not.toHaveBeenCalled();
  });
});
