import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { als, assertTxUsable, type RequestContext } from '@/lib/als';
import { sql } from '@/lib/neon';
import type { ControlPrincipal, ControlTx } from './contracts';

const issuedContexts = new WeakMap<ControlTx, PoolClient>();
type AuthenticatedIdentity = Pick<ControlPrincipal, 'personId' | 'companyId' | 'authMethod'>
  & Partial<Pick<ControlPrincipal, 'connectionId' | 'grantId' | 'grantedScopes' | 'actingFirmId'>>;

/** Authentication middleware supplies this identity; request args are never input. */
export function makeControlPrincipal(identity: AuthenticatedIdentity): ControlPrincipal {
  if (!identity.personId || !identity.companyId || identity.authMethod === 'job') {
    throw new Error('Authenticated tenant principal required');
  }
  const bearer = identity.authMethod !== 'cookie';
  if (bearer && (!identity.connectionId || !identity.grantId || !identity.grantedScopes)) {
    throw new Error('Authenticated grant identity required');
  }
  return Object.freeze({
    personId: identity.personId, companyId: identity.companyId, authMethod: identity.authMethod,
    connectionId: identity.connectionId ?? null, grantId: identity.grantId ?? null,
    actingFirmId: identity.actingFirmId ?? null, delegatedByPersonId: null,
    requestId: randomUUID(), operationId: randomUUID(), provenance: bearer ? 'agent' : 'human',
    grantedScopes: bearer ? Object.freeze([...identity.grantedScopes!]) : null,
  });
}

export function requireControlTx(): ControlTx {
  assertTxUsable();
  const store = als.getStore();
  const principal = store?.controlPrincipal;
  if (!store || !principal || principal.personId !== store.userId || principal.companyId !== store.companyId) {
    throw new Error('Authenticated control transaction required');
  }
  const ctx: ControlTx = Object.freeze({ principal,
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => sql(strings, ...values),
  });
  issuedContexts.set(ctx, store.client);
  return ctx;
}

/** Prevent forged service arguments or a permit surviving its originating transaction. */
export function assertControlTx(ctx: ControlTx): void {
  const store = als.getStore();
  if (!store || issuedContexts.get(ctx) !== store.client || ctx.principal !== store.controlPrincipal
    || ctx.principal.companyId !== store.companyId || ctx.principal.personId !== store.userId) {
    throw new Error('Control transaction does not match authenticated request');
  }
  assertTxUsable();
}

export function assertControlIntegrity(): void {
  if (als.getStore()?.controlWriteFailed) throw new Error('Required control evidence could not be committed');
}

/** Wrappers await this before COMMIT, including when a handler catches a refusal. */
export async function withControlRequest<T>(store: RequestContext, identity: AuthenticatedIdentity,
  handler: () => Promise<T>): Promise<T> {
  if (store.userId !== identity.personId || store.companyId !== identity.companyId) {
    throw new Error('Authenticated identity does not match transaction');
  }
  store.controlPrincipal = makeControlPrincipal(identity);
  return als.run(store, async () => {
    const result = await handler();
    if (store.controlWriteFailed) throw new Error('Required control evidence could not be committed');
    return result;
  });
}
