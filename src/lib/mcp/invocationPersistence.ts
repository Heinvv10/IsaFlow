import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { assertControlTx } from '@/modules/accounting/services/controls/context';
import type { ControlTx, ControlPrincipal } from '@/modules/accounting/services/controls/contracts';
import type { TransactionOutcome } from '@/modules/accounting/services/controls/transactionObservers';
import type { InvocationAdmissionInput, InvocationCompletion } from './invocationTypes';
import { InvocationStoreError } from './invocationTypes';
import { classifyInvocationProof } from './invocationProof';
interface Snapshot { readonly identity: 'captured-invocation' }
const snapshots = new WeakMap<Snapshot, Readonly<ControlPrincipal>>();
let pool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new InvocationStoreError();
    pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 2000, idleTimeoutMillis: 10000,
      statement_timeout: 3000, query_timeout: 3000,
      ssl: process.env.DATABASE_SSL === 'strict' ? { rejectUnauthorized: true } : process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false } });
    pool.on('error', () => log.warn('Invocation pool background failure', {}, 'mcp'));
  }
  return pool;
}
export function captureInvocationIdentity(ctx: ControlTx): Snapshot {
  assertControlTx(ctx);
  const snapshot: Snapshot = Object.freeze({ identity: 'captured-invocation' });
  snapshots.set(snapshot, Object.freeze({ ...ctx.principal, grantedScopes: ctx.principal.grantedScopes && Object.freeze([...ctx.principal.grantedScopes]) }));
  return snapshot;
}
/** Private callback boundary: exported functions below each own fixed tagged SQL, never caller SQL. */
async function independently<T>(snapshot: Snapshot, action: (principal: Readonly<ControlPrincipal>) => Promise<T>): Promise<T> {
  const principal = snapshots.get(snapshot);
  if (!principal) throw new InvocationStoreError();
  let client: pg.PoolClient;
  try { client = await getPool().connect(); } catch { throw new InvocationStoreError(); }
  let failed = false;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    const claims = { sub: principal.personId, role: 'authenticated', company_id: principal.companyId };
    return await als.run({ client, userId: principal.personId, companyId: principal.companyId, claims }, async () => {
      await sql`SELECT set_config('request.jwt.claims',${JSON.stringify(claims)},true),set_config('app.current_company_id',${principal.companyId},true)`;
      const result = await action(principal);
      const committed = await client.query('COMMIT');
      if (committed.command !== 'COMMIT') throw new InvocationStoreError();
      return result;
    });
  } catch {
    failed = true;
    try { await client.query('ROLLBACK'); } catch { log.warn('Invocation rollback unavailable; discarding connection', {}, 'mcp'); }
    throw new InvocationStoreError();
  } finally { client.release(failed); }
}
export async function persistInvocationAdmission(snapshot: Snapshot, input: InvocationAdmissionInput, attemptId: string, xid: string): Promise<void> {
  await independently(snapshot, async principal => {
    await sql`INSERT INTO mcp_invocation_attempts(company_id,id,person_id,auth_method,grant_id,connection_id,request_id,operation_id,
      tool,args_hash,key_hash,outer_xid) VALUES(${principal.companyId}::uuid,${attemptId}::uuid,${principal.personId},${principal.authMethod},
      ${principal.grantId},${principal.connectionId},${principal.requestId}::uuid,${principal.operationId}::uuid,${input.tool},${input.argsHash},${input.idempotencyKeyHash},${xid}::xid8)`;
  });
}
export async function persistInvocationOutcome(snapshot: Snapshot, attemptId: string, outcome: TransactionOutcome,
  completion: InvocationCompletion | null, source: 'observer' | 'reconciled'): Promise<void> {
  await independently(snapshot, async principal => {
    await sql`INSERT INTO mcp_invocation_outcomes(company_id,attempt_id,id,transaction_outcome,source,status,reported_write,reason_code,duration_ms)
      VALUES(${principal.companyId}::uuid,${attemptId}::uuid,${randomUUID()}::uuid,${outcome},${source},${completion?.status ?? null},
        ${completion?.reportedWrite ?? null},${completion?.reasonCode ?? null},${completion?.durationMs ?? null})
      ON CONFLICT(company_id,attempt_id,transaction_outcome) DO NOTHING`;
  });
}
/** Explicit shutdown for process lifecycle/tests; no public query or identity injection surface. */
export async function closeInvocationPool(): Promise<void> { const previous = pool; pool = null; if (previous) await previous.end(); }

/** A separate connection observes only durable receipts; savepoint-discarded receipts cannot certify completion. */
export async function verifyInvocationOutcome(snapshot: Snapshot, attemptId: string): Promise<ReturnType<typeof classifyInvocationProof>> {
  return independently(snapshot, async principal => {
    const rows = await sql`SELECT pg_xact_status(a.outer_xid) AS transaction_status,r.status,r.reported_write,r.reason_code,r.duration_ms
      FROM mcp_invocation_attempts a LEFT JOIN mcp_invocation_receipts r
        ON r.company_id=a.company_id AND r.attempt_id=a.id AND r.outer_xid=a.outer_xid
      WHERE a.company_id=${principal.companyId}::uuid AND a.id=${attemptId}::uuid` as Array<{
        transaction_status:string|null;status:InvocationCompletion['status']|null;reported_write:boolean;reason_code:InvocationCompletion['reasonCode'];duration_ms:number}>;
    const row=rows[0];
    if(!row)throw new InvocationStoreError();
    return classifyInvocationProof(row.transaction_status,row.status?{status:row.status,reportedWrite:row.reported_write,durationMs:row.duration_ms,
      ...(row.reason_code?{reasonCode:row.reason_code}:{})}:null);
  });
}
