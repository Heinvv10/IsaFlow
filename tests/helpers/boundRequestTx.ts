/**
 * Binds a fake request transaction to the current async context, for a unit test of code that refuses to run
 * outside one (`settleDocumentByContra`). The client only answers SAVEPOINT / RELEASE / ROLLBACK with no rows, so a
 * real `withSavepoint` runs over it; `statements` records them. Call it from `beforeEach`.
 */
import { als, type RequestContext } from '@/lib/als';

export function bindRequestTx(companyId: string, overrides: Partial<RequestContext> = {}): string[] {
  const statements: string[] = [];
  const client = { query: async (text: string) => { statements.push(text); return { rows: [], rowCount: 0 }; } };
  als.enterWith({ client, userId: 'test-user', companyId, claims: {}, ...overrides } as unknown as RequestContext);
  return statements;
}
