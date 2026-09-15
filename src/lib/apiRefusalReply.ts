/**
 * How a refusal that declares its own status is ANSWERED — the responder half of `apiRefusal.ts`,
 * which is the half that decides WHICH errors qualify.
 *
 * The same split this tree already uses one module over: `lockTimeout.ts` recognises a typed row-lock
 * timeout and `apiDocumentLock.ts` answers one. It earns the second file twice over here. The
 * recogniser is imported by `withAuth`, which sits in the import graph of every route, so it must stay
 * free of `@/lib/apiResponse` — a route test that mocks the response helper would otherwise start
 * failing on a module it never touched. And this responder must stay OUT of `api-error-handler.ts`,
 * which route tests routinely mock wholesale to make `withErrorHandler` a pass-through: a function
 * those routes call cannot live behind that mock.
 */
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { typedRefusalCode } from '@/lib/apiRefusal';

/**
 * Answer a registered refusal with the status its class declares, returning true when it did — so
 * `withErrorHandler`, or a route that wants it ahead of its own branches, can
 * `if (respondIfTypedRefusal(res, err)) return;` and leave everything else to the 500. Exactly the
 * shape of `respondIfLockTimeout`.
 *
 * The class's OWN wording is sent, not a masked generic, and in production too: these messages are
 * authored refusal text naming the caller's next action, never pg output or a schema name. Its own
 * `code` rides in `details`, again like `respondIfLockTimeout` — the envelope's `error.code` is the
 * transport class (CONFLICT), which does not say WHICH refusal fired, and `OPERATION_APPROVAL_REQUIRED`
 * is what a client keys on to offer "request an approval".
 */
export function respondIfTypedRefusal(res: NextApiResponse, err: unknown): boolean {
  const code = typedRefusalCode(err);
  if (code === null) return false;
  apiResponse.error(res, code, (err as Error).message, { code: (err as { code: string }).code });
  return true;
}
