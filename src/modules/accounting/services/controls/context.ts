import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { als, assertTxUsable, type RequestContext } from '@/lib/als';
import { sql } from '@/lib/neon';
import type { ControlPrincipal, ControlTx } from './contracts';
import type {AuditJobLease} from './auditJobLease';
import {loadStoredAuditJobDelegation} from './auditJobDelegation';
import {assertPlatformImportPrincipal} from '@/lib/auth/platformImportAuthority';

interface Lifetime { active: boolean; store: RequestContext; client: PoolClient; principal: ControlPrincipal }
export class ControlIntegrityError extends Error {
  constructor() { super('Required control evidence could not be committed'); this.name = 'ControlIntegrityError'; }
}
const activeRequests = new WeakMap<RequestContext, Lifetime>();
const issuedContexts = new WeakMap<ControlTx, Lifetime>();

/** Own thenable: no global LazyQuery escapes and each execution checks its lease. */
class ControlQuery implements Promise<unknown[]> {
  readonly [Symbol.toStringTag] = 'ControlQuery';
  private result?: Promise<unknown[]>;
  constructor(private ctx: ControlTx, private strings: TemplateStringsArray, private values: unknown[]) {}
  private run(): Promise<unknown[]> {
    try {
      assertControlTx(this.ctx);
      return this.result ??= sql(this.strings, ...this.values).then(rows => rows);
    } catch (error) { return Promise.reject(error); }
  }
  then<T = unknown[], E = never>(fulfilled?: ((value: unknown[]) => T | PromiseLike<T>) | null,
    rejected?: ((reason: unknown) => E | PromiseLike<E>) | null): Promise<T | E> {
    return this.run().then(fulfilled, rejected);
  }
  catch<E = never>(rejected?: ((reason: unknown) => E | PromiseLike<E>) | null): Promise<unknown[] | E> {
    return this.run().catch(rejected);
  }
  finally(callback?: (() => void) | null): Promise<unknown[]> { return this.run().finally(callback); }
}
type AuthenticatedIdentity = Pick<ControlPrincipal, 'personId' | 'companyId' | 'authMethod'>
  & Partial<Pick<ControlPrincipal, 'connectionId' | 'grantId' | 'grantedScopes' | 'actingFirmId' | 'impersonatorPersonId'>>;

/** Authentication middleware supplies this identity; request args are never input. */
export function makeControlPrincipal(identity: AuthenticatedIdentity): ControlPrincipal {
  if (!identity.personId || !identity.companyId || (identity.authMethod === 'job' || identity.authMethod === 'platform_import')) {
    throw new Error('Authenticated tenant principal required');
  }
  const bearer = identity.authMethod !== 'cookie';
  if (bearer && (!identity.connectionId || !identity.grantId || !identity.grantedScopes)) {
    throw new Error('Authenticated grant identity required');
  }
  // Only a browser session can be driven by an impersonating administrator.
  if (bearer && identity.impersonatorPersonId) throw new Error('An impersonated grant identity is not authenticated');
  return Object.freeze({
    personId: identity.personId, companyId: identity.companyId, authMethod: identity.authMethod,
    connectionId: identity.connectionId ?? null, grantId: identity.grantId ?? null,
    actingFirmId: identity.actingFirmId ?? null, delegatedByPersonId: null,
    impersonatorPersonId: identity.impersonatorPersonId ?? null,
    requestId: randomUUID(), operationId: randomUUID(), provenance: bearer ? 'agent' : 'human',
    grantedScopes: bearer ? Object.freeze([...identity.grantedScopes!]) : null,
  });
}

export function requireControlTx(): ControlTx {
  assertTxUsable();
  const store = als.getStore();
  const principal = store?.controlPrincipal;
  const lifetime = store && activeRequests.get(store);
  if (!store || !principal || !lifetime?.active || lifetime.principal !== principal || lifetime.client !== store.client || principal.personId !== store.userId || principal.companyId !== store.companyId) {
    throw new Error('Authenticated control transaction required');
  }
  const ctx: ControlTx = Object.freeze({ principal,
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
      assertControlTx(ctx);
      return new ControlQuery(ctx, strings, values);
    },
  });
  issuedContexts.set(ctx, lifetime);
  return ctx;
}

/** Prevent forged service arguments or a permit surviving its originating transaction. */
export function assertControlTx(ctx: ControlTx): void {
  const store = als.getStore();
  const lifetime = issuedContexts.get(ctx);
  if (!store || !lifetime?.active || lifetime.store !== store || activeRequests.get(store) !== lifetime
    || lifetime.client !== store.client || lifetime.principal !== ctx.principal || ctx.principal !== store.controlPrincipal
    || ctx.principal.companyId !== store.companyId || ctx.principal.personId !== store.userId) {
    throw new Error('Control transaction does not match authenticated request');
  }
  if(ctx.principal.authMethod==='platform_import')assertPlatformImportPrincipal(ctx.principal,store);
  assertTxUsable();
}

export function assertControlIntegrity(): void {
  if (als.getStore()?.controlWriteFailed) throw new ControlIntegrityError();
}

/** Wrappers await this before COMMIT, including when a handler catches a refusal. */
export async function withControlRequest<T>(store: RequestContext, identity: AuthenticatedIdentity,
  handler: () => Promise<T>): Promise<T> {
  if (store.userId !== identity.personId || store.companyId !== identity.companyId) {
    throw new Error('Authenticated identity does not match transaction');
  }
  return withPrincipal(store,makeControlPrincipal(identity),handler);
}

/** A background context retains original delegation and current grant checks, never a synthetic cookie. */
export async function withControlJobRequest<T>(store:RequestContext,lease:AuditJobLease,handler:()=>Promise<T>):Promise<T>{
  const {assertIssuedAuditJobLease}=await import('./auditJobLease');
  assertIssuedAuditJobLease(lease,store.companyId,store.userId);
  if(activeRequests.get(store)?.active)throw new Error('Control request already active');
  return als.run(store,async()=>{
    const saved=await loadStoredAuditJobDelegation(sql,lease.companyId,lease.personId,lease);
    const principal:ControlPrincipal=Object.freeze({companyId:lease.companyId,personId:lease.personId,
      connectionId:saved.authority.connectionId,grantId:saved.authority.grantId,actingFirmId:saved.authority.actingFirmId,
      authMethod:'job',provenance:'job',delegatedByPersonId:lease.personId,impersonatorPersonId:null,requestId:randomUUID(),operationId:randomUUID(),
      grantedScopes:Object.freeze([...saved.permissions]),jobId:lease.jobId,jobLeaseId:lease.leaseId,jobGeneration:lease.generation});
    return withPrincipal(store,principal,async()=>{
      const {assertEffectivePermission}=await import('@/lib/auth/effectivePermissions');
      const ctx=requireControlTx();
      for(const permission of saved.permissions)await assertEffectivePermission(ctx,permission);
      return handler();
    });
  });
}

async function withPrincipal<T>(store:RequestContext,principal:ControlPrincipal,handler:()=>Promise<T>):Promise<T>{
  if (activeRequests.get(store)?.active) throw new Error('Control request already active');
  store.controlPrincipal = principal;
  const lifetime: Lifetime = { active: true, store, client: store.client, principal: store.controlPrincipal };
  activeRequests.set(store, lifetime);
  return als.run(store, async () => {
    try {
      const result = await handler();
      if (store.controlWriteFailed) throw new ControlIntegrityError();
      return result;
    } finally {
      lifetime.active = false;
      activeRequests.delete(store);
    }
  });
}

/** Only an active privately registered platform-import target can enter this lifetime. */
export async function withControlPlatformImportRequest<T>(store:RequestContext,principal:ControlPrincipal,handler:()=>Promise<T>):Promise<T>{
 assertPlatformImportPrincipal(principal,store);
 return withPrincipal(store,principal,handler);
}
