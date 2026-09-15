/**
 * A refusal whose CLASS declares a status must reach the client with it.
 *
 * Two classes in this tree already declared `statusCode = 409` — `ApApprovalRequiredError` and
 * `ArApprovalRequiredError` — and NOTHING read the field. A route that did not model the class
 * rethrew, `withErrorHandler` answered its blanket 500 `INTERNAL_SERVER_ERROR`, and a refusal the
 * caller could have acted on ("request an approval, then retry") arrived as a server fault. The
 * declaration was decorative.
 *
 * So the table in `apiRefusal.ts` is the reader, and this file is what stops the two drifting: it
 * asserts the status the table answers with EQUALS the status the class declares, for every class in
 * the table, and that every class carrying a declared `statusCode` is IN the table. A new refusal
 * class that declares 409 and is never registered fails here rather than silently answering 500.
 *
 * The negative half matters as much. Recognition is by CLASS, never by a duck-typed `statusCode`:
 * an outbound HTTP client, a storage SDK or `jose` can all attach `statusCode` to an error, and a
 * server fault wearing someone else's 403 must stay a 500.
 */
import { describe, it, expect } from 'vitest';
import { STATUS_CODE_MAP } from '@/lib/apiResponse';
import { typedRefusalAnswer, typedRefusalCode, TYPED_REFUSALS } from '@/lib/apiRefusal';
import { respondIfTypedRefusal } from '@/lib/apiRefusalReply';
import { OperationApprovalRequiredError } from '@/modules/accounting/services/controls/approvalExecutionService';
import { ApApprovalRequiredError } from '@/modules/accounting/services/ap/apControlBoundary';
import { ArApprovalRequiredError } from '@/modules/accounting/services/ar/arControlBoundary';
import { IndependentReviewRefusal } from '@/modules/accounting/services/controls/independentReview';

interface Sent { status: number; body: { success: boolean; error?: { code: string; message: string } } }
function makeRes() {
  const sent: Sent = { status: 0, body: { success: true } };
  const res = {
    status(code: number) { sent.status = code; return res; },
    json(body: unknown) { sent.body = body as Sent['body']; return res; },
    setHeader() { return res; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { res: res as any, sent };
}

/** One instance of every registered class, so the table cannot be tested against itself. */
const instances = [
  new OperationApprovalRequiredError(),
  new ApApprovalRequiredError('supplier_payment.process', 'payment-1'),
  new ArApprovalRequiredError('customer_invoice.post', 'invoice-1'),
  new IndependentReviewRefusal('An impersonated session cannot record an independent review'),
];

describe('respondIfTypedRefusal — the declared status is the answered status', () => {
  it.each(instances.map(e => [e.name, e] as const))('%s answers its own declared status', (_name, err) => {
    const { res, sent } = makeRes();
    expect(respondIfTypedRefusal(res, err)).toBe(true);
    expect(sent.status).toBe(err.statusCode);
    expect(sent.body.success).toBe(false);
    // The class's own code and its own wording, not a masked generic: the whole
    // point is that the caller is told what to do next.
    expect(sent.body.error?.message).toBe(err.message);
    // The wrappers answer a POISONED request from `typedRefusalAnswer` instead of
    // this responder, so the two must agree on status and code or the same refusal
    // would reach the client differently depending on which path it took.
    expect(typedRefusalAnswer(err)).toEqual({ status: err.statusCode, code: err.code, message: err.message });
  });

  it('every registered entry maps to the status its class declares', () => {
    for (const [cls, errorCode] of TYPED_REFUSALS) {
      const instance = instances.find(e => e instanceof cls);
      expect(instance, `no instance in this test for ${cls.name}`).toBeDefined();
      expect(STATUS_CODE_MAP[errorCode]).toBe(instance!.statusCode);
    }
  });

  it('registers every class this test knows carries a declared statusCode', () => {
    for (const instance of instances) {
      expect(TYPED_REFUSALS.some(([cls]) => instance instanceof cls), `${instance.name} is not registered`).toBe(true);
    }
  });

  it('declares only 4xx: a refusal may never choose a 5xx or a 2xx', () => {
    for (const instance of instances) {
      expect(instance.statusCode).toBeGreaterThanOrEqual(400);
      expect(instance.statusCode).toBeLessThan(500);
    }
  });
});

describe('respondIfTypedRefusal — what it must NOT claim', () => {
  it('declines a plain Error, so it stays a 500', () => {
    const { res, sent } = makeRes();
    expect(respondIfTypedRefusal(res, new Error('Committed operation effect is ambiguous'))).toBe(false);
    expect(sent.status).toBe(0);
  });

  it('declines a pg driver error, whatever its SQLSTATE', () => {
    for (const code of ['23505', '42501', 'P0001', '40P01']) {
      const { res } = makeRes();
      expect(respondIfTypedRefusal(res, Object.assign(new Error('violates constraint "uq_x"'), { code }))).toBe(false);
    }
  });

  it('declines an error that merely CARRIES statusCode — the duck-typing hazard', () => {
    // An outbound fetch, a storage SDK or jose attaching its own HTTP status to
    // a server fault must never choose this API's status. Asserted against
    // `typedRefusalCode` as well as the responder, because that is the single
    // reader of the table and therefore the thing a widening mutation changes.
    const { res, sent } = makeRes();
    const foreign = Object.assign(new Error('Upstream object store said no'), { statusCode: 403, code: 'AccessDenied' });
    expect(typedRefusalCode(foreign)).toBeNull();
    expect(respondIfTypedRefusal(res, foreign)).toBe(false);
    expect(sent.status).toBe(0);
  });

  it('typedRefusalCode declines a plain Error and a driver error too', () => {
    expect(typedRefusalCode(new Error('Approval could not be consumed'))).toBeNull();
    expect(typedRefusalCode(Object.assign(new Error('deadlock detected'), { code: '40P01' }))).toBeNull();
  });

  it('declines a non-Error', () => {
    const { res } = makeRes();
    expect(respondIfTypedRefusal(res, { statusCode: 409, code: 'OPERATION_APPROVAL_REQUIRED' })).toBe(false);
  });
});

describe('the three approval-required classes agree on one code', () => {
  it('all carry OPERATION_APPROVAL_REQUIRED, so a transport can match the reason', () => {
    for (const err of instances.slice(0, 3)) expect(err.code).toBe('OPERATION_APPROVAL_REQUIRED');
  });

  it('are distinguishable by name, because the code alone does not say which refused', () => {
    const names = instances.slice(0, 3).map(e => e.name);
    expect(new Set(names).size).toBe(3);
  });
});
