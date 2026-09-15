/**
 * A refusal whose CLASS declares the status the client should be told, answered centrally.
 *
 * Same shape and the same reason as `respondIfLockTimeout` next door: a typed refusal raised deep in a
 * service reached the client as `withErrorHandler`'s blanket 500 `INTERNAL_SERVER_ERROR` — whose
 * message it also masks in production — unless every route on the way up happened to model the class.
 * `supplier-payments-action` did not, so "request an approval for this operation and retry" arrived as
 * a server fault; `ApApprovalRequiredError` had declared `statusCode = 409` since it was written and
 * nothing in the tree ever read the field.
 *
 * RECOGNITION IS BY CLASS, NEVER BY A DUCK-TYPED `statusCode`. An outbound fetch, an object-store SDK
 * and `jose` all attach their own HTTP status to errors, and a server fault wearing someone else's 403
 * must stay a 500. The table below is the whole allowlist; `typedRefusalStatus.test.ts` asserts the
 * status each entry answers with equals the status its class declares, so the two cannot drift, and
 * that a class carrying a declared `statusCode` which is NOT registered fails the build's tests rather
 * than silently answering 500.
 *
 * ONLY FOR A REFUSAL RAISED BEFORE THE REQUEST'S FIRST WRITE. `withAuth` COMMITs anything below 500,
 * so a 4xx answered after a partial write commits it. Every class here satisfies that: the three
 * approval-required classes are raised by `executeControlledOperation` before its savepoint writes
 * anything (and `runJournalControl` separately forces the ROLLBACK the direct-journal routes need,
 * because those write their draft OUTSIDE the controlled write), and `assertIndependentRequestReview`
 * is the first statement of every approver-of-record service that calls it.
 */

import { ErrorCode, STATUS_CODE_MAP } from '@/lib/apiResponse.types';
import { OperationApprovalRequiredError } from '@/modules/accounting/services/controls/approvalExecutionService';
import { IndependentReviewRefusal } from '@/modules/accounting/services/controls/independentReview';
import { ApApprovalRequiredError } from '@/modules/accounting/services/ap/apControlBoundary';
import { ArApprovalRequiredError } from '@/modules/accounting/services/ar/arControlBoundary';

/** A refusal class this transport may answer for: it declares its own 4xx and a stable code. */
export interface TypedRefusal extends Error {
  readonly code: string;
  readonly statusCode: number;
}

type RefusalClass = new (...args: never[]) => TypedRefusal;

/**
 * The allowlist, exported so the test can assert the mapping against each class's own declaration.
 *
 * The three approval-required classes share one code deliberately — the kernel's own and the AP/AR
 * boundary wrappers alike — so a transport can match the reason without knowing which layer refused.
 */
export const TYPED_REFUSALS: ReadonlyArray<readonly [RefusalClass, ErrorCode]> = [
  [OperationApprovalRequiredError as unknown as RefusalClass, ErrorCode.CONFLICT],
  [ApApprovalRequiredError as unknown as RefusalClass, ErrorCode.CONFLICT],
  [ArApprovalRequiredError as unknown as RefusalClass, ErrorCode.CONFLICT],
  [IndependentReviewRefusal as unknown as RefusalClass, ErrorCode.BAD_REQUEST],
];

/**
 * The ErrorCode a registered refusal is answered with, or null if it is not one — the ONE reader of the
 * table, so there is a single place a refusal can be recognised and a single place to mutate to prove
 * the recognition is load-bearing. Matching is `instanceof` against the allowlist and nothing else.
 */
export function typedRefusalCode(err: unknown): ErrorCode | null {
  if (!(err instanceof Error)) return null;
  return TYPED_REFUSALS.find(([cls]) => err instanceof cls)?.[1] ?? null;
}

/**
 * The wire answer for a registered refusal — status, code and message — or null when it is not one.
 *
 * Deliberately built from the class's OWN `statusCode` and `code` rather than from the response
 * helper, so the wrappers (`withAuth`, `bearerPipeline`) can answer a poisoned request's refusal
 * without importing `@/lib/apiResponse`. That import is not free: `withAuth` is in the import graph of
 * every route, so a route test that mocks `apiResponse` would start failing on a module it never
 * touched. `respondIfTypedRefusal` in `api-error-handler.ts` is the half that does use the helper.
 */
export function typedRefusalAnswer(err: unknown): { status: number; code: string; message: string } | null {
  const errorCode = typedRefusalCode(err);
  if (errorCode === null) return null;
  const refusal = err as TypedRefusal;
  // STATUS_CODE_MAP, not `refusal.statusCode`: the envelope's code and its status must agree, and the
  // test asserts the two are the same number for every registered class.
  return { status: STATUS_CODE_MAP[errorCode], code: refusal.code, message: refusal.message };
}
