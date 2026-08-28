/**
 * Run a service call as if it were inside a request transaction.
 *
 * `lockBankTransactionForUpdate` refuses to run without an ALS request context
 * — outside one, `FOR UPDATE` is released the moment the SELECT returns, so a
 * caller would believe it was serialised when it was not. Unit tests that mock
 * `@/lib/neon` therefore have to supply a context; the client here is never
 * used by those tests (every query goes to the sql mock), it only has to exist.
 */
import { als } from '@/lib/als';

type Ctx = Parameters<typeof als.run>[0];

export function fakeRequestCtx(client?: unknown): Ctx {
  return {
    client: client ?? { query: async () => ({ rows: [] }) },
    userId: 'test-user',
    companyId: 'test-company',
    claims: {},
  } as unknown as Ctx;
}

/**
 * Enter a fake request context for the rest of this async execution — call it
 * from a `beforeEach` so every test in the file can reach the ALS client
 * without wrapping each call site.
 */
export function enterFakeRequestCtx(client?: unknown): void {
  als.enterWith(fakeRequestCtx(client));
}

/** Await `fn` inside a fake request context. */
export function runInRequestCtx<T>(fn: () => Promise<T>, client?: unknown): Promise<T> {
  return als.run(fakeRequestCtx(client), fn);
}
