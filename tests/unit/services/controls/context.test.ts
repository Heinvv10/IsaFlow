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
  it('rejects forged contexts and contexts reused outside their transaction', async () => {
    let retained: ReturnType<typeof requireControlTx> | undefined;
    await withControlRequest({ client, userId: 'u1', companyId: 'a', claims: {} },
      { personId: 'u1', companyId: 'a', authMethod: 'cookie' }, async () => {
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

it('refuses issuing contexts from fabricated ALS even when principal fields match', () => {
  expect(() => als.run({ client, userId: 'u1', companyId: 'a', claims: {}, controlPrincipal: principal }, requireControlTx)).toThrow();
});
it('guards retained query calls and lazy execution after the request exits', async () => {
  let retained: ReturnType<typeof requireControlTx>;
  let deferred: ReturnType<ReturnType<typeof requireControlTx>['sql']>;
  await withControlRequest({ client, userId: 'u1', companyId: 'a', claims: {} },
    { personId: 'u1', companyId: 'a', authMethod: 'cookie' }, async () => {
      retained = requireControlTx(); deferred = retained.sql`SELECT 1`;
    });
  expect(() => retained!.sql`SELECT 1`).toThrow();
  await expect(Promise.resolve(deferred!)).rejects.toThrow('Control transaction');
});
it('revokes a detached callback inheriting ALS after handler completion', async () => {
  let resume!: () => void;
  const barrier = new Promise<void>(resolve => { resume = resolve; });
  let detached!: Promise<boolean>;
  await withControlRequest({ client, userId: 'u1', companyId: 'a', claims: {} },
    { personId: 'u1', companyId: 'a', authMethod: 'cookie' }, async () => {
      const ctx = requireControlTx();
      detached = (async () => { await barrier; assertControlTx(ctx); return true; })();
    });
  resume();
  await expect(detached).rejects.toThrow('Control transaction');
});
it('executes once on the issuing client and rejects reuse in a different live request', async () => {
  vi.mocked(client.query).mockResolvedValue({ rows: [{ ok: true }] } as never);
  let retained!: ReturnType<typeof requireControlTx>;
  let query!: ReturnType<ReturnType<typeof requireControlTx>['sql']>;
  await withControlRequest({ client, userId: 'u1', companyId: 'a', claims: {} },
    { personId: 'u1', companyId: 'a', authMethod: 'cookie' }, async () => {
      retained = requireControlTx(); query = retained.sql`SELECT ${1}`;
      expect(await query).toEqual([{ ok: true }]);
      expect(await query).toEqual([{ ok: true }]);
    });
  expect(client.query).toHaveBeenCalledTimes(1);
  await withControlRequest({ client, userId: 'u1', companyId: 'a', claims: {} },
    { personId: 'u1', companyId: 'a', authMethod: 'cookie' }, async () => {
      expect(() => retained.sql`SELECT 1`).toThrow();
      await expect(Promise.resolve(query)).rejects.toThrow('Control transaction');
    });
  expect(client.query).toHaveBeenCalledTimes(1);
});
