/**
 * Decision 18's header test, shared by every budget reader and writer that applies the leaf rule
 * (gridSave, gridReadAccounts, seedSeries). One copy, so the rule cannot drift between them.
 */
import { sql } from '@/lib/neon';

/**
 * A `sql` fragment: the `gl_accounts` row aliased `ga` is named as `parent_account_id` by another
 * account of its company, active or not (the leafAccountOptions rule). Built per call, not at
 * import, so a unit test's `vi.mock('@/lib/neon')` is never called while modules load.
 */
export const isHeaderSql = () => sql`EXISTS (SELECT 1 FROM gl_accounts ch WHERE ch.company_id = ga.company_id AND ch.parent_account_id = ga.id)`;
