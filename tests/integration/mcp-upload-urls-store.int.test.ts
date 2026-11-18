/**
 * mcp_upload_intents store paths against real Postgres (999q):
 *  - the global sweep: an expired row loses its bytes but stays, an unexpired one keeps them, a finalized row survives
 *    any age, an unfinalized row 7 days past expiry is deleted, and another company's expired row is swept too;
 *  - stageUploadBytes' compare-and-set: two concurrent PUTs of one token stage once; a PUT after expiry stages nothing;
 *  - entity-arm dedup (findFinalizedSameBytes): the same bytes on the same entity are a duplicate while the document is
 *    active; a removed document, another entity and another company are not. A bank line's removed attachment is not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import {
  findFinalizedSameBytes, markIntentFinalized, stageUploadBytes,
} from '@/modules/accounting/services/core/mcpUploadIntentStore';
import { sweepExpiredUploads } from '@/modules/accounting/services/core/mcpUploadIntentSweep';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBankTx, seedBill, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { dropDocuments, procDoc } from './helpers/documentFixture';
import { inAppUserTx } from './helpers/appUserTx';
import {
  PDF, bankFile, createUrls, dropUploads, finalize, put, seedMember, sha, type Json,
} from './helpers/mcpUploadHarness';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('MCP upload intents: sweep, stage compare-and-set, entity dedup (999q)', () => {
  let fx: Fixture; let other: Fixture;
  let lines: string[]; let otherLine: string; let bill: string; let bill2: string; let otherBill: string;
  const first = (r: Json) => (r.uploads as Json[])[0]!;
  const row = async (id: unknown) => (await sql`
    SELECT status, staged_bytes IS NOT NULL AS has_bytes FROM mcp_upload_intents WHERE id = ${String(id)}::UUID`)[0];
  const expire = (id: unknown, ago: string) =>
    sql`UPDATE mcp_upload_intents SET expires_at = now() - ${ago}::INTERVAL WHERE id = ${String(id)}::UUID`;
  /** One uploaded (staged, unfinalized) bank-line intent of `f`. */
  const uploaded = async (f: Fixture, line: string, tag: string) => {
    const b = PDF(tag);
    const u = first(await createUrls(f, [bankFile(line, `${tag}.pdf`, b)]));
    expect(await put(String(u.url), b)).toBe(200);
    return u;
  };
  const entityFile = (target: string, b: Buffer) =>
    ({ target: { entity_type: 'supplier_invoice', entity_id: target }, file_name: 'bill.pdf', mime_type: 'application/pdf', size: b.length, sha256: sha(b) });

  beforeAll(async () => {
    assertNotProductionDb('This test seeds companies, bank lines, bills, uploads and documents.');
    fx = await seedFixture('UPLS', DATABASE_URL!);
    other = await seedFixture('UPLSB', DATABASE_URL!);
    for (const f of [fx, other]) await seedMember(f);
    lines = [];
    for (let i = 0; i < 4; i += 1) lines.push(await seedBankTx(fx, { date: '2026-11-0' + (i + 1), amount: -10 - i, description: `s ${i}` }));
    otherLine = await seedBankTx(other, { date: '2026-11-01', amount: -5, description: 'theirs' });
    bill = await seedBill(fx, { number: 'S1', date: '2026-11-01', total: 100 });
    bill2 = await seedBill(fx, { number: 'S2', date: '2026-11-01', total: 200 });
    otherBill = await seedBill(other, { number: 'S3', date: '2026-11-01', total: 300 });
  }, 120000);

  afterAll(async () => {
    for (const f of [fx, other]) {
      if (!f) continue;
      await dropDocuments(f);
      await dropUploads(f);
      await dropFixture(f);
      await sql`DELETE FROM users WHERE id = ${f.userId}`;
    }
  }, 120000);

  it('sweeps expired bytes in every company, keeps unexpired bytes and finalized rows, deletes a week past expiry', async () => {
    const expired = await uploaded(fx, lines[0]!, 'sw-expired');
    const live = await uploaded(fx, lines[0]!, 'sw-live');
    const theirs = await uploaded(other, otherLine, 'sw-theirs');
    const old = first(await createUrls(fx, [bankFile(lines[0]!, 'old.pdf', PDF('sw-old'))]));
    const done = await uploaded(fx, lines[0]!, 'sw-done');
    expect(((await finalize(fx, [done.upload_id])).files as Json[])[0]).toMatchObject({ status: 'finalized' });
    await expire(expired.upload_id, '1 minute');
    await expire(theirs.upload_id, '1 minute');
    await expire(old.upload_id, '8 days');
    await expire(done.upload_id, '30 days');

    // Judged by the rows, not the count: a suite running beside this one may sweep them first, and a row another
    // sweep holds is skipped (SKIP LOCKED) and left to the next one, so sweep until settled (bounded).
    for (let n = 0; n < 20; n += 1) {
      await sweepExpiredUploads();
      const [a, b] = [await row(expired.upload_id), await row(theirs.upload_id)];
      if (!a?.has_bytes && !b?.has_bytes && (await row(old.upload_id)) === undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await row(expired.upload_id)).toEqual({ status: 'uploaded', has_bytes: false });
    expect(await row(theirs.upload_id)).toEqual({ status: 'uploaded', has_bytes: false });
    expect(await row(live.upload_id)).toEqual({ status: 'uploaded', has_bytes: true });
    expect(await row(done.upload_id)).toEqual({ status: 'finalized', has_bytes: false });
    expect(await row(old.upload_id)).toBeUndefined();
    // The swept row reads expired, not not_found.
    expect(((await finalize(fx, [expired.upload_id])).files as Json[])[0]).toMatchObject({ status: 'expired' });
  });

  it('stages one of two concurrent PUTs of the same token; a PUT after expiry stages nothing', async () => {
    const b = PDF('cas');
    const u = first(await createUrls(fx, [bankFile(lines[1]!, 'cas.pdf', b)]));
    const codes = await Promise.all([put(String(u.url), b), put(String(u.url), b), put(String(u.url), b)]);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c !== 200).every((c) => c === 409)).toBe(true);
    const audits = await sql`SELECT count(*)::INT AS n FROM audit_log WHERE company_id = ${fx.companyId}::UUID
      AND changes->'metadata'->>'source' = 'mcp upload PUT' AND changes->'metadata'->>'upload_id' = ${String(u.upload_id)}`;
    expect(audits[0]!.n).toBe(1);
    // Store level: a second stage of the uploaded row is refused by the predicate.
    expect(await inTx(fx, () => stageUploadBytes(fx.companyId, String(u.upload_id), b))).toBe(false);

    const late = PDF('cas late');
    const v = first(await createUrls(fx, [bankFile(lines[1]!, 'late.pdf', late)]));
    await expire(v.upload_id, '1 second');
    expect(await inTx(fx, () => stageUploadBytes(fx.companyId, String(v.upload_id), late))).toBe(false);
    expect(await row(v.upload_id)).toEqual({ status: 'pending', has_bytes: false });
  });

  it('entity dedup: the same bytes on the same active document only; not removed, not another entity or company', async () => {
    const b = PDF('entity');
    const u = first(await createUrls(fx, [entityFile(bill, b)]));
    expect(await put(String(u.url), b)).toBe(200);
    // finalize_uploads writes the entity store through object storage, which the gate does not run: stand its row in
    // and mark the intent finalized as the tool does (999q's trigger checks the document is the bill's and active).
    const doc = await procDoc('supplier_invoice', bill, { name: 'bill.pdf' });
    await inAppUserTx(fx, () => markIntentFinalized(fx.companyId, String(u.upload_id), doc, false));

    expect(await findFinalizedSameBytes(fx.companyId, 'supplier_invoice', bill, sha(b))).toBe(doc);
    expect(first(await createUrls(fx, [entityFile(bill, b)]))).toMatchObject({ status: 'duplicate', document_id: doc });
    expect(await findFinalizedSameBytes(fx.companyId, 'supplier_invoice', bill2, sha(b))).toBeNull();
    expect(first(await createUrls(fx, [entityFile(bill2, b)]))).toMatchObject({ status: 'url_issued' });
    expect(await findFinalizedSameBytes(other.companyId, 'supplier_invoice', bill, sha(b))).toBeNull();
    expect(first(await createUrls(other, [entityFile(otherBill, b)]))).toMatchObject({ status: 'url_issued' });
    expect(await findFinalizedSameBytes(fx.companyId, 'supplier_invoice', bill, sha(PDF('other bytes')))).toBeNull();

    await sql`UPDATE procurement_documents SET is_active = false WHERE id = ${doc}::UUID`;
    expect(await findFinalizedSameBytes(fx.companyId, 'supplier_invoice', bill, sha(b))).toBeNull();
    expect(first(await createUrls(fx, [entityFile(bill, b)]))).toMatchObject({ status: 'url_issued' });
  });

  it('bank dedup: an attachment since removed from the line is not a duplicate', async () => {
    const b = PDF('removed');
    const u = await uploaded(fx, lines[2]!, 'removed');
    const att = ((await finalize(fx, [u.upload_id])).files as Json[])[0]!.document_id;
    expect(first(await createUrls(fx, [bankFile(lines[2]!, 'again.pdf', b)]))).toMatchObject({ status: 'duplicate' });
    await sql`DELETE FROM bank_transaction_attachments WHERE id = ${String(att)}::UUID`;
    expect(first(await createUrls(fx, [bankFile(lines[2]!, 'again.pdf', b)]))).toMatchObject({ status: 'url_issued' });
  });
});
