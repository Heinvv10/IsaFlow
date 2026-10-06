/**
 * The bounded number lock of migration 864, for numbers the APP mints as MAX(seq)+1.
 *
 * Two writers reading the same MAX mint the same number; the second then fails 23505 on the unique index. Taking
 * `take_number_lock(scope, seed)` on the request transaction BEFORE the MAX read makes the second writer wait for
 * the first to commit (at most 5 s — then 55P03, which withErrorHandler / respondIfLockTimeout answer 503 +
 * Retry-After) and its MAX, a later statement, sees the first number.
 *
 * The scope is what the MAX filters on; the company id is cast through ::uuid::text in SQL so it hashes exactly
 * as the journal trigger's `company_id::text` does. Seeds are documented in migration 864's header.
 */
import { sql } from '@/lib/neon';

/** 857's journal key. A number minted in a transaction that also posts a journal shares it (858, measured). */
export const JOURNAL_NUMBER_SEED = 857;
export const ASSET_NUMBER_SEED = 864001;
export const PROJECT_NUMBER_SEED = 864002;
export const CLAIM_NUMBER_SEED = 864003;
export const ITEM_CODE_SEED = 864004;
/** Platform-wide admin billing numbers: scope is the 'INV-YYYYMM-' prefix, taken on the admin transaction. */
export const ADMIN_INVOICE_NUMBER_SEED = 864005;

/** Lock '<company_id>' (suffix null) or '<company_id>:<suffix>' under `seed` on the current request transaction. */
export async function takeCompanyNumberLock(companyId: string, suffix: string | null, seed: number): Promise<void> {
  await sql`
    SELECT public.take_number_lock(
      ${companyId}::uuid::text || COALESCE(':' || ${suffix}::text, ''), ${seed}::bigint)
  `;
}
