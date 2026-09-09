import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { assertControlTx, makeControlPrincipal, requireControlTx, withControlRequest } from '@/modules/accounting/services/controls/context';

const principal = makeControlPrincipal({ personId: 'u1', companyId: 'a', authMethod: 'pat',
  connectionId: 'pat1', grantId: 'pat1', grantedScopes: ['write:invoices'] });
const client = { query: vi.fn() } as unknown as PoolClient;

describe('transaction-bound control authority', () => {
  it('never manufactures a principal from an unauthenticated background call', () => {
    expect(() => requireControlTx()).toThrow();
    expect(() => als.run({ client, userId: 'u1', companyId: 'a', claims: {} }, requireControlTx)).toThrow();
  });
  it('binds authenticated person and tenant and rejects mismatched ALS data', () => {
    expect(() => als.run({ client, userId: 'u2', companyId: 'a', claims: {}, controlPrincipal: principal }, requireControlTx)).toThrow();
    expect(() => als.run({ client, userId: 'u1', companyId: 'b', claims: {}, controlPrincipal: principal }, requireControlTx)).toThrow();
  });
  it('rejects forged contexts and contexts reused outside their transaction', () => {
    let retained: ReturnType<typeof requireControlTx> | undefined;
    als.run({ client, userId: 'u1', companyId: 'a', claims: {}, controlPrincipal: principal }, () => {
      const ctx = requireControlTx(); retained = ctx;
      expect(() => assertControlTx(ctx)).not.toThrow();
      expect(() => assertControlTx({ ...ctx })).toThrow();
    });
    expect(() => assertControlTx(retained!)).toThrow();
  });
  it('records token identity separately from person and freezes grant ceilings', () => {
    const scopes = ['write:invoices'];
    const identity = makeControlPrincipal({ personId: 'u1', companyId: 'a', authMethod: 'pat',
      connectionId: 'pat2', grantId: 'pat2', grantedScopes: scopes });
    scopes.push('write:post');
    expect(identity.personId).toBe(principal.personId);
    expect(identity.connectionId).not.toBe(principal.connectionId);
    expect(identity.grantedScopes).toEqual(['write:invoices']);
    expect(identity.provenance).toBe('agent');
    expect(identity.requestId).not.toBe(principal.requestId);
    expect(Object.isFrozen(identity)).toBe(true);
  });
  it('propagates authenticated context and refuses completion when required audit failed', async () => {
    const store = { client, userId: 'u1', companyId: 'a', claims: {} };
    await expect(withControlRequest(store, { personId: 'u1', companyId: 'a', authMethod: 'cookie' }, async () => {
      expect(requireControlTx().principal.authMethod).toBe('cookie');
      als.getStore()!.controlWriteFailed = true;
    })).rejects.toThrow('evidence');
  });
});
