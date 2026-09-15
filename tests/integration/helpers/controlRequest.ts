import type { Pool } from 'pg';
import { withControlRequest } from '@/modules/accounting/services/controls/context';
import { settleControlTransaction } from '@/modules/accounting/services/controls/transactionObservers';

/**
 * Run `handler` inside ONE authenticated control request that commits.
 *
 * Financial services reach their principal through AsyncLocalStorage, not through an argument:
 * `requireControlTx()` reads the store that `withControlRequest` installs, so a service called
 * from a bare `pool.query` test throws "Authenticated control transaction required" no matter
 * what identifiers the test passes in. This is the smallest wrapper that supplies a real one.
 *
 * Deliberately NOT `SET LOCAL ROLE app_user`: callers here connect as the superuser that seeded
 * their tenant, and the suites using this helper assert ledger behaviour rather than RLS. A
 * suite that means to prove tenant isolation must set the role itself and seed through it.
 */
export async function inControlRequest<T>(
  pool: Pool, userId: string, companyId: string, handler: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claims = { sub: userId, role: 'authenticated', company_id: companyId };
    await client.query(
      "SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",
      [JSON.stringify(claims), companyId]);
    const result = await withControlRequest({ client, userId, companyId, claims },
      { personId: userId, companyId, authMethod: 'cookie' }, handler);
    // settleControlTransaction runs the deferred control observers; without it the evidence the
    // services queued is never flushed and a later assertion reads a half-written request.
    await client.query('COMMIT');
    await settleControlTransaction(client, 'committed');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    await settleControlTransaction(client, 'rolled_back');
    throw error;
  } finally { client.release(); }
}

/**
 * Delete every control-table row a tenant owns, so `DELETE FROM companies` can succeed.
 *
 * Five triggers on `companies` seed a mandatory-policy row the moment a company is inserted
 * (control_seed_{compensation,import,match_override,release,statement}_policy), and any control
 * operation leaves effects, entity versions and change events behind. A teardown written before
 * those existed hits `control_mandatory_compensation_policies_company_id_fkey` and leaves the
 * tenant in the fixture, so the NEXT run starts dirty.
 *
 * Driven from the catalog rather than a hand-kept list: the list has grown with every control
 * migration, and a stale one fails the same way. Identifiers come back already quoted by
 * `quote_ident` — an identifier cannot be a bind parameter, and these names are pg_catalog's,
 * never a caller's. Repeats until no progress because the control tables reference each other.
 */
export async function purgeCompanyControlRows(pool: Pool, companyId: string): Promise<void> {
  const { rows } = await pool.query<{ ident: string }>(`
    SELECT DISTINCT quote_ident(c.relname) AS ident
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_class f ON f.oid = k.confrelid
    WHERE k.contype = 'f' AND f.relname = 'companies' AND c.relname LIKE 'control\\_%'`);
  let pending = rows.map(r => r.ident);
  while (pending.length) {
    const blocked: string[] = [];
    for (const ident of pending) {
      try {
        await pool.query(`DELETE FROM ${ident} WHERE company_id = $1`, [companyId]);
      } catch (error) {
        // A child table still holds rows pointing here; retry after this pass clears it.
        if ((error as { code?: string }).code !== '23503') throw error;
        blocked.push(ident);
      }
    }
    if (blocked.length === pending.length) {
      throw new Error(`Control rows for ${companyId} form a delete cycle: ${blocked.join(', ')}`);
    }
    pending = blocked;
  }
}
