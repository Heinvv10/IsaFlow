import { describe, it, expect } from 'vitest';
import { nextStatus } from '@/modules/accounting/services/commentary/commentaryState';

describe('nextStatus', () => {
  it('creates a draft when nothing exists', () => {
    expect(nextStatus(null, 'generate')).toEqual({ ok: true, next: 'draft', clearsApproval: false });
  });

  it('approves a draft', () => {
    expect(nextStatus('draft', 'approve')).toEqual({ ok: true, next: 'approved', clearsApproval: false });
  });

  it('rejects a draft', () => {
    expect(nextStatus('draft', 'reject')).toEqual({ ok: true, next: 'rejected', clearsApproval: false });
  });

  it('re-drafts a rejected row', () => {
    expect(nextStatus('rejected', 'generate')).toEqual({ ok: true, next: 'draft', clearsApproval: false });
  });

  it('refuses to silently overwrite approved text with a new draft', () => {
    const t = nextStatus('approved', 'generate');
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.reason).toContain('approved');
  });

  it('withdraws an approval only under the explicit regenerate action, and says so', () => {
    expect(nextStatus('approved', 'regenerate')).toEqual({ ok: true, next: 'draft', clearsApproval: true });
  });

  it('refuses to approve twice, so a second approver cannot overwrite the first', () => {
    expect(nextStatus('approved', 'approve').ok).toBe(false);
  });

  it('refuses to approve a rejected row', () => {
    expect(nextStatus('rejected', 'approve').ok).toBe(false);
  });

  it('refuses to reject anything that is not a draft', () => {
    expect(nextStatus('approved', 'reject').ok).toBe(false);
    expect(nextStatus('rejected', 'reject').ok).toBe(false);
    expect(nextStatus(null, 'reject').ok).toBe(false);
  });

  it('refuses to approve a row that does not exist', () => {
    expect(nextStatus(null, 'approve').ok).toBe(false);
  });

  it('refuses regenerate on a draft — there is no approval to withdraw', () => {
    expect(nextStatus('draft', 'regenerate').ok).toBe(false);
  });
});
