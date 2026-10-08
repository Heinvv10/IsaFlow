/**
 * R-035 N1: a refusal raised by the definer writers (migration 872) reaches
 * the route as the SAME error the TypeScript check throws for that case, so
 * approval-requests answers the same status, reason and message class.
 * Anything else — a forgery refusal (RA009), a 23505, a deadlock — is passed
 * through untouched.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { decideRefusal, raiseRefusal } from '@/modules/accounting/services/gl/approvalRequestWrites';
import { ApprovalDecisionError, ApprovalNotRequiredError } from '@/modules/accounting/services/gl/approvalAuthority';
import { ApprovalDocumentNotFoundError } from '@/modules/accounting/services/gl/approvalDocuments';
import { ApprovalRequestStaleError } from '@/modules/accounting/services/gl/approvalDocumentErrors';
import {
  ApprovalDocumentChangedError, ApprovalExpectedDigestRequiredError,
} from '@/modules/accounting/services/gl/approvalDecideDocument';
import { ImpersonationForbiddenError } from '@/lib/auth/impersonationGuard';

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
const REQ = '11111111-1111-1111-1111-111111111111';

describe('decideRefusal', () => {
  it.each([
    ['RA001', 'SELF_APPROVAL_FORBIDDEN'],
    ['RA002', 'APPROVER_ROLE_REQUIRED'],
    ['RA003', 'IMPERSONATION_FORBIDDEN'],
    ['RA008', 'APPROVER_ROLE_REQUIRED'],
  ])('%s is ApprovalDecisionError %s (403), with the SQL message', (state, code) => {
    const mapped = decideRefusal(pgError(state, 'This approval requires the owner role'), REQ);
    expect(mapped).toBeInstanceOf(ApprovalDecisionError);
    expect(mapped).toMatchObject({ code, message: 'This approval requires the owner role' });
  });

  it('RA004 is DOCUMENT_CHANGED (409), RA005 EXPECTED_DIGEST_REQUIRED (400)', () => {
    expect(decideRefusal(pgError('RA004', 'x'), REQ)).toEqual(new ApprovalDocumentChangedError(REQ));
    expect(decideRefusal(pgError('RA004', 'x'), REQ)).toBeInstanceOf(ApprovalDocumentChangedError);
    expect(decideRefusal(pgError('RA005', 'x'), REQ)).toBeInstanceOf(ApprovalExpectedDigestRequiredError);
  });

  it('RA006 is ApprovalDocumentNotFoundError (404) naming the document the SQL named', () => {
    const mapped = decideRefusal(pgError('RA006', `No supplier_invoice ${REQ} exists for this company`), 'r');
    expect(mapped).toBeInstanceOf(ApprovalDocumentNotFoundError);
    expect((mapped as Error).message).toBe(`No supplier_invoice ${REQ} exists for this company`);
  });

  it.each(['RA009', '23505', '40P01', undefined])('%s passes through untouched', (state) => {
    const error = state ? pgError(state, 'boom') : new Error('boom');
    expect(decideRefusal(error, REQ)).toBe(error);
  });
});

describe('raiseRefusal', () => {
  it('RA003 → ImpersonationForbiddenError, RA006 → not found (400), RA007 → not required (400)', () => {
    expect(raiseRefusal(pgError('RA003', 'x'), 'supplier_invoice', REQ)).toBeInstanceOf(ImpersonationForbiddenError);
    expect(raiseRefusal(pgError('RA006', 'x'), 'supplier_invoice', REQ)).toEqual(
      new ApprovalDocumentNotFoundError('supplier_invoice', REQ));
    expect(raiseRefusal(pgError('RA007', 'x'), 'supplier_invoice', REQ)).toBeInstanceOf(ApprovalNotRequiredError);
  });

  it('RA010 (a stricter rule governs now) → ApprovalRequestStaleError, reason APPROVAL_RULES_CHANGED', () => {
    const mapped = raiseRefusal(pgError('RA010', 'x'), 'supplier_invoice', REQ);
    expect(mapped).toBeInstanceOf(ApprovalRequestStaleError);
    expect(mapped).toMatchObject({ code: 'APPROVAL_RULES_CHANGED' });
  });

  it.each(['RA009', 'RA008', 'RA001', '23505'])('%s passes through untouched', (state) => {
    const error = pgError(state, 'boom');
    expect(raiseRefusal(error, 'supplier_invoice', REQ)).toBe(error);
  });
});
