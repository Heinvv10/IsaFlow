/**
 * The one decision between "this line was refused" and "this run is broken".
 * Only the kernel's typed refusals count; a coding defect (builtin error,
 * ZodError, a plain Error from anywhere) or a poisoned request is a fault that
 * must reach Bugsink as a 500, never a toast as "N refused".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { als } from '@/lib/als';
import { classifyAutoPostRefusal } from '@/modules/accounting/services/bank/bankRuleAutoPostRefusal';
import { OperationApprovalRequiredError, SuppliedApprovalRefusal } from '@/modules/accounting/services/controls/approvalExecutionService';
import { BeneficiaryError } from '@/modules/accounting/services/controls/beneficiaryValidation';
import { EffectivePermissionError } from '@/lib/auth/effectivePermissionQueries';
import { ClosedFiscalPeriodError, LOCKDOWN_REFUSAL_MESSAGE, VAT_PERIOD_REFUSAL_MESSAGE } from '@/modules/accounting/services/gl/postingPeriodGuard';
import { enterFakeRequestCtx } from '../../helpers/requestCtx';

beforeEach(() => enterFakeRequestCtx());

describe('classifyAutoPostRefusal — the kernel\'s typed refusals', () => {
  it.each([
    [new OperationApprovalRequiredError(), { kind: 'approval_required' }],
    [new BeneficiaryError('LEGACY_UNVERIFIED'), { kind: 'beneficiary_unverified', reason: 'LEGACY_UNVERIFIED' }],
    [new ClosedFiscalPeriodError('closed'), { kind: 'closed_period' }],
    [new Error(LOCKDOWN_REFUSAL_MESSAGE), { kind: 'lockdown' }],
    [new Error(VAT_PERIOD_REFUSAL_MESSAGE), { kind: 'vat_period_filed' }],
    [new SuppliedApprovalRefusal('Approval material changed'), { kind: 'refused', reason: 'Approval material changed' }],
    [Object.assign(new Error('raised by a control function'), { code: '42501', suppliedApprovalRefusal: true }), { kind: 'refused', reason: 'raised by a control function' }],
  ])('%s → per-line outcome', (error, outcome) => {
    expect(classifyAutoPostRefusal(error)).toEqual(outcome);
  });

  it('a permission refusal carries its message', () => {
    const error = new EffectivePermissionError('Current permissions do not allow this operation.');
    expect(classifyAutoPostRefusal(error)).toEqual({ kind: 'permission_denied', reason: error.message });
  });
});

describe('classifyAutoPostRefusal — faults', () => {
  it.each([
    ['a plain Error from inside the write', new Error('Bank allocation state changed')],
    ['the effect\'s own period backstop', new Error('Open bank accounting period required')],
    ['a TypeError', new TypeError('Cannot read properties of undefined')],
    ['a RangeError', new RangeError('Invalid array length')],
    ['a ReferenceError', new ReferenceError('x is not defined')],
    ['a SyntaxError', new SyntaxError('Unexpected token')],
    ['a ZodError', (() => { try { z.object({ a: z.string() }).parse({}); } catch (e) { return e; } return null; })()],
    ['a pg error', Object.assign(new Error('deadlock detected'), { code: '40P01' })],
    ['a non-Error', 'boom'],
  ])('%s → null, the run aborts', (_label, error) => {
    expect(classifyAutoPostRefusal(error)).toBeNull();
  });

  it('a typed refusal thrown after the request is poisoned is a fault regardless', () => {
    als.getStore()!.controlWriteFailed = true;
    expect(classifyAutoPostRefusal(new ClosedFiscalPeriodError('closed'))).toBeNull();
    expect(classifyAutoPostRefusal(new OperationApprovalRequiredError())).toBeNull();
  });
});
