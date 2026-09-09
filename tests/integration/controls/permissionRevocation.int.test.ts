import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Pool } from 'pg';
import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture, validateFixtureTarget, type ForensicFixture } from '../forensic-fixture';
import { assertEffectivePermission } from '../../../src/lib/auth/effectivePermissions';
import { withControlRequest, requireControlTx } from '../../../src/modules/accounting/services/controls/context';
import { PAT_SCOPES } from '../../../src/lib/auth/patScopes';
import type { ControlPrincipal, ControlTx } from '../../../src/modules/accounting/services/controls/contracts';

// Refuse omitted opt-in, remote target or DATABASE_URL fallback before creating a pool.
const config = fixtureConfigFromEnv(process.env);
const target = validateFixtureTarget(config);
process.env.DATABASE_URL = target.connectionString;
process.env.DATABASE_SSL = 'disable';
const pool = new Pool({ connectionString: target.connectionString, ssl: false, max: 3,
  connectionTimeoutMillis: 3000, statement_timeout: 5000 });
let fixture: ForensicFixture;
beforeAll(async () => { fixture = await provisionForensicFixture(config); });
beforeEach(async () => {
  await pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2", [fixture.companyA, fixture.u1.id]);
  await pool.query("UPDATE users SET is_active=true,status='active',suspended_at=NULL WHERE id=$1", [fixture.u1.id]);
  await pool.query('DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2', [fixture.companyA, fixture.u1.id]);
  await pool.query("UPDATE personal_access_tokens SET revoked_at=NULL,expires_at=clock_timestamp()+interval '1 day',scopes=$1 WHERE company_id=$2 AND user_id=$3",
    [[...PAT_SCOPES], fixture.companyA, fixture.u1.id]);
});
afterAll(async () => {
  try {
    if (fixture) {
      await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [[fixture.companyA, fixture.companyB]]);
      await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [[fixture.u1.id, fixture.u2.id, fixture.u3.id]]);
    }
  } finally { await pool.end(); }
});
function principal(tokenIndex = 0): ControlPrincipal {
  return { companyId: fixture.companyA, personId: fixture.u1.id,
    connectionId: fixture.u1.tokens[tokenIndex]!.id, grantId: fixture.u1.tokens[tokenIndex]!.id, actingFirmId: null,
    requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), authMethod: 'pat', provenance: 'agent',
    delegatedByPersonId: null, grantedScopes: [...PAT_SCOPES] };
}
async function asActor<T>(who: ControlPrincipal, run: (ctx: ControlTx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",
      [JSON.stringify({ sub: who.personId, role: 'authenticated', company_id: who.companyId }), who.companyId]);
    return await withControlRequest({ client, userId: who.personId, companyId: who.companyId,
      claims: { sub: who.personId, company_id: who.companyId } }, who, () => run(requireControlTx()));
  } finally { await client.query('ROLLBACK'); client.release(); }
}
it('revokes both tokens of the same person immediately after role downgrade, while retaining reads', async () => {
  for (const index of [0, 1]) await asActor(principal(index), ctx => assertEffectivePermission(ctx, 'write:journals'));
  await pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2", [fixture.companyA, fixture.u1.id]);
  await pool.query(`INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write)
    VALUES($1,$2,'accounts',true)`, [fixture.companyA, fixture.u1.id]);
  for (const index of [0, 1]) {
    await expect(asActor(principal(index), ctx => assertEffectivePermission(ctx, 'write:journals')))
      .rejects.toMatchObject({ code: 'CONTROL_FORBIDDEN' });
    await asActor(principal(index), ctx => assertEffectivePermission(ctx, 'read:reports'));
  }
});
it('honours admin module deny, account suspension and foreign-tenant token mismatch', async () => {
  await pool.query(`INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write)
    VALUES($1,$2,'accounts',false)`, [fixture.companyA, fixture.u1.id]);
  await expect(asActor(principal(), ctx => assertEffectivePermission(ctx, 'write:journals'))).rejects.toThrow();
  await pool.query('UPDATE users SET is_active=false WHERE id=$1', [fixture.u1.id]);
  await expect(asActor(principal(), ctx => assertEffectivePermission(ctx, 'read:reports'))).rejects.toThrow();
  // Establish an active allowed principal first: suspension must not mask a tenant-isolation failure.
  await pool.query('UPDATE users SET is_active=true WHERE id=$1', [fixture.u1.id]);
  await asActor(principal(), ctx => assertEffectivePermission(ctx, 'read:reports'));
  await expect(asActor({ ...principal(), companyId: fixture.companyB }, ctx => assertEffectivePermission(ctx, 'read:reports')))
    .rejects.toThrow();
});
it('rechecks persisted PAT scopes, expiry and revocation instead of the request copy', async () => {
  const who = principal();
  await pool.query('UPDATE personal_access_tokens SET scopes=$1 WHERE id=$2', [['read:reports'], who.connectionId]);
  await expect(asActor(who, ctx => assertEffectivePermission(ctx, 'write:journals'))).rejects.toThrow();
  await asActor(who, ctx => assertEffectivePermission(ctx, 'read:reports'));
  await pool.query("UPDATE personal_access_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [who.connectionId]);
  await expect(asActor(who, ctx => assertEffectivePermission(ctx, 'read:reports'))).rejects.toThrow();
  await pool.query("UPDATE personal_access_tokens SET expires_at=clock_timestamp()+interval '1 day',revoked_at=clock_timestamp() WHERE id=$1", [who.connectionId]);
  await expect(asActor(who, ctx => assertEffectivePermission(ctx, 'read:reports'))).rejects.toThrow();
});
it('holds membership, token and absent-override insertion fences until the executing transaction ends', async () => {
  const other = await pool.connect();
  try {
    await asActor(principal(), async ctx => {
      await assertEffectivePermission(ctx, 'write:journals');
      for (const [text, values] of [
        ["UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2", [fixture.companyA, fixture.u1.id]],
        ['UPDATE personal_access_tokens SET revoked_at=clock_timestamp() WHERE id=$1', [ctx.principal.connectionId]],
        ["INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write) VALUES($1,$2,'accounts',false)", [fixture.companyA, fixture.u1.id]],
      ] as const) {
        await other.query('BEGIN');
        await other.query("SET LOCAL lock_timeout='100ms'");
        await expect(other.query(text, [...values])).rejects.toMatchObject({ code: '55P03' });
        await other.query('ROLLBACK');
      }
    });
    // Once the authorization transaction ends the same downgrade can complete.
    await other.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2", [fixture.companyA, fixture.u1.id]);
  } finally { await other.query('ROLLBACK'); other.release(); }
});
it('retains manager ordinary writes but requires explicit forensic capability for cookie approvals', async () => {
  await pool.query("UPDATE company_users SET role='manager' WHERE company_id=$1 AND user_id=$2", [fixture.companyA, fixture.u1.id]);
  const who: ControlPrincipal = { ...principal(), authMethod: 'cookie', provenance: 'human', grantedScopes: null };
  await asActor(who, ctx => assertEffectivePermission(ctx, 'write:contacts'));
  await expect(asActor(who, ctx => assertEffectivePermission(ctx, 'write:approvals'))).rejects.toThrow();
  await pool.query(`INSERT INTO company_user_permissions(company_id,user_id,module_key,can_approve)
    VALUES($1,$2,'approvals',true)`, [fixture.companyA, fixture.u1.id]);
  await asActor(who, ctx => assertEffectivePermission(ctx, 'write:approvals'));
});
it('checks current OAuth authorization scopes and expiry with owner-only RLS', async () => {
  const appId = crypto.randomUUID(), grantId = crypto.randomUUID();
  await pool.query(`INSERT INTO oauth_apps
    (id,name,redirect_uris,client_id,client_secret_hash,client_secret_prefix,owner_user_id)
    VALUES($1,'Synthetic permission fixture',$2,$3,$4,'synthetic',$5)`,
  [appId, ['https://forensic.invalid/callback'], appId, `synthetic-${appId}`, fixture.u1.id]);
  await pool.query(`INSERT INTO oauth_authorisations
    (id,oauth_app_id,user_id,company_id,scopes,access_token_expires_at,refresh_token_hash,refresh_token_prefix,refresh_token_expires_at)
    VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 day',$6,'synthetic',clock_timestamp()+interval '1 day')`,
  [grantId, appId, fixture.u1.id, fixture.companyA, [...PAT_SCOPES], `synthetic-${grantId}`]);
  const who: ControlPrincipal = { ...principal(), authMethod: 'oauth', connectionId: grantId, grantId };
  await asActor(who, ctx => assertEffectivePermission(ctx, 'write:journals'));
  await pool.query('UPDATE oauth_authorisations SET scopes=$1 WHERE id=$2', [['read:reports'], grantId]);
  await expect(asActor(who, ctx => assertEffectivePermission(ctx, 'write:journals'))).rejects.toThrow();
  await asActor(who, ctx => assertEffectivePermission(ctx, 'read:reports'));
  await pool.query('UPDATE oauth_authorisations SET access_token_expires_at=NULL WHERE id=$1', [grantId]);
  await expect(asActor(who, ctx => assertEffectivePermission(ctx, 'read:reports'))).rejects.toThrow();
  await pool.query("UPDATE oauth_authorisations SET access_token_expires_at=clock_timestamp()+interval '1 day',revoked_at=clock_timestamp() WHERE id=$1", [grantId]);
  await expect(asActor(who, ctx => assertEffectivePermission(ctx, 'read:reports'))).rejects.toThrow();
});
