import type { Pool, QueryResult } from 'pg';

/**
 * Statements run as one person's app_user session: request.jwt.claims names the person, so the 688/689 guards
 * treat them as that person acting. For fixtures whose shape no service can produce (a synthetic binding), this is
 * the person taking the step, never a forgery on someone else's behalf.
 */
export async function asPerson(pool: Pool, person: { id: string; companyId: string },
  statements: ReadonlyArray<readonly [string, unknown[]]>): Promise<QueryResult[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",
      [JSON.stringify({ sub: person.id, company_id: person.companyId, role: 'authenticated' }), person.companyId]);
    const results: QueryResult[] = [];
    for (const [text, params] of statements) results.push(await client.query(text, params));
    await client.query('COMMIT'); return results;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

/**
 * Fixture only: writes an approval row the 688 guards refuse, to stand in for a state no transaction can reach
 * now: a legacy row (an uppercase entity id, a row born consumed before 688), a corrupted one (an erased effect
 * link, a rewritten binding), or elapsed time (an expired approval). session_replication_role=replica skips user
 * triggers for this one transaction and needs a superuser; no application role can do this.
 */
export async function rewriteApprovalUnguarded(pool: Pool, text: string, params: unknown[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role='replica'");
    await client.query(text, params);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
