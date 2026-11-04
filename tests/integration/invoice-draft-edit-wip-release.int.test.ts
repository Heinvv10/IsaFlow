/**
 * PR S round twelve: a draft PUT releases only the time entries it names (`releaseTimeEntryIds`, sent by the edit page
 * after the user confirmed removing the line). A linked line the body leaves unlinked without naming it is refused
 * (400 INVOICE_WIP_LINK_REFUSED), nothing written: a body whose lines all came back `timeEntryId: null` (a client
 * that sends the key but not the links) would otherwise unbill time still charged. Named entries must be ones this
 * invoice's lines link, and not ones a line keeps.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { cleanupPr4, invoiceCompany } from './r035-pr4.helpers';
import { entry, links, putBody, timeEntry, wipDraft, wipPut, type WipCtx } from './invoice-wip-links.helpers';

assertDisposable();
const ctx: WipCtx = { pool: new Pool({ connectionString: process.env.DATABASE_URL }), tokens: {}, owner: '', company: '', otherCompany: '' };
const companies: string[] = [];
const A = (te: string | null) => ({ description: 'Time A', quantity: 2, unitPrice: 300, taxRate: 15, timeEntryId: te });
const B = (te: string | null) => ({ description: 'Time B', quantity: 1, unitPrice: 400, taxRate: 15, timeEntryId: te });
const codeOf = (res: { state: { body: unknown } }) => (res.state.body as { error?: { details?: { code?: string } } }).error?.details?.code;

beforeAll(async () => {
  ctx.owner = await createUser(ctx.pool, ctx.tokens);
  ctx.company = await invoiceCompany(ctx.pool, [[ctx.owner, 'owner']], companies);
  ctx.otherCompany = await invoiceCompany(ctx.pool, [[ctx.owner, 'owner']], companies);
}, 60_000);
afterAll(async () => { await cleanupPr4(ctx.pool, companies, [ctx.owner]); });

describe('a draft PUT releases only the entries it names', () => {
  it.each([
    ['every line back with timeEntryId: null', (e: string[]) => putBody('', [A(null), B(null)])],
    ['a kept line, the other back unlinked and not named', (e: string[]) => putBody('', [A(e[0]!), B(null)])],
    ['a line left out and not named', (e: string[]) => putBody('', [A(e[0]!)])],
    ['a named entry this invoice does not link', (e: string[]) => putBody('', [A(e[0]!), B(e[1]!)], { releaseTimeEntryIds: [crypto.randomUUID()] })],
    ['a named entry a line keeps', (e: string[]) => putBody('', [A(e[0]!), B(e[1]!)], { releaseTimeEntryIds: [e[1]] })],
  ])('%s: 400 INVOICE_WIP_LINK_REFUSED; lines and entries unchanged', async (_name, make) => {
    const { id, entries } = await wipDraft(ctx);
    const before = { lines: await links(ctx, id), entries: await Promise.all(entries.map((e) => entry(ctx, e))) };
    const res = await wipPut(ctx, { ...make(entries), id });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(codeOf(res)).toBe('INVOICE_WIP_LINK_REFUSED');
    expect({ lines: await links(ctx, id), entries: await Promise.all(entries.map((e) => entry(ctx, e))) }).toEqual(before);
  });

  it('a removed line named in releaseTimeEntryIds (as the page sends it after the question): released', async () => {
    const { id, entries } = await wipDraft(ctx);
    const res = await wipPut(ctx, putBody(id, [A(entries[0]!)], { releaseTimeEntryIds: [entries[1]!.toUpperCase()] }));
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await entry(ctx, entries[1]!)).toMatchObject({ status: 'approved', invoice_id: null, billed: false });
    expect(await entry(ctx, entries[0]!)).toMatchObject({ status: 'billed', invoice_id: id });
  });

  it('a line kept on the invoice but unlinked, its entry named: released, the line stays as text', async () => {
    const { id, entries } = await wipDraft(ctx);
    const res = await wipPut(ctx, putBody(id, [A(entries[0]!), B(null)], { releaseTimeEntryIds: [entries[1]] }));
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect((await links(ctx, id)).map((l) => l.time_entry_id)).toEqual([entries[0], null]);
    expect(await entry(ctx, entries[1]!)).toMatchObject({ status: 'approved', invoice_id: null });
  });

  it('an unbilled entry of this company, never on this invoice, is not made billed or touched by a release name', async () => {
    const { id, entries } = await wipDraft(ctx);
    const free = await timeEntry(ctx, ctx.company, null);
    const res = await wipPut(ctx, putBody(id, [A(entries[0]!), B(entries[1]!)], { releaseTimeEntryIds: [free] }));
    expect(res.state.statusCode).toBe(400);
    expect(await entry(ctx, free)).toMatchObject({ status: 'approved', invoice_id: null });
  });
});
