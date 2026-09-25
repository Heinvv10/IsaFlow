// R-107 — attaching a captured document to a provisional journal claims it.
//
// POST /api/accounting/provisional/[jeId]/attach flips a bank-first provisional
// journal (DR expense / CR bank, already posted) to "evidenced" by a captured
// slip. It never stamped captured_documents.posted_at, so the same slip stayed
// postable through every capture route: a second journal expensing the same
// bank line, and the same input VAT claimed twice. The route also selected two
// columns captured_documents does not have (source_document_hash,
// extraction_confidence — they are gl_journal_entries columns), so it raised
// 42703 on every call: the double post was dormant behind a route that had
// never worked, and fixing the columns alone would have woken it.
//
// Every case runs through the real routes (withAuth, app_user, RLS) and asserts
// the outcome: the status, the claim column, and the rows that changed.
import { describe, expect, it } from 'vitest';
import {
  attach, company, docPostedAt, jeState, btStatus, journalsFor, otherCompany, postReceipt,
  seedDoc, seedProvisional, useR107Fixture,
} from './r107-provisional-attach.helpers';

useR107Fixture();

describe('R-107: attaching a captured document to a provisional journal claims it', () => {
  it('evidences the journal from the slip and claims the slip', async () => {
    const { je, bt } = await seedProvisional();
    const doc = await seedDoc(company);

    const out = await attach(je, doc);

    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    const state = await jeState(je);
    expect(state.needs_evidence).toBe(false);
    expect(state.source_document_id).toBe(doc);
    expect(state.source_document_hash).toBe(`sha-${doc}`);
    expect(state.posting_agent).toBe('ai-evidenced:v1');
    expect(await btStatus(bt)).toBe('matched');
    expect(await docPostedAt(doc)).not.toBeNull();
  });

  it('the attached slip cannot then be posted again through a capture route', async () => {
    const { je } = await seedProvisional();
    const doc = await seedDoc(company);
    expect((await attach(je, doc)).statusCode).toBe(200);

    const again = await postReceipt(doc);

    expect(again.statusCode, JSON.stringify(again.body)).toBe(400);
    expect(again.body.error?.message).toMatch(/already posted/i);
    expect(await journalsFor(doc)).toBe(1);
  });

  it('refuses a slip already posted through capture, and writes nothing', async () => {
    const { je, bt } = await seedProvisional();
    const doc = await seedDoc(company, { status: 'matched', posted: true });

    const out = await attach(je, doc);

    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(/already posted/i);
    expect((await jeState(je)).needs_evidence).toBe(true);
    expect((await jeState(je)).source_document_id).toBeNull();
    expect(await btStatus(bt)).toBe('provisional');
  });

  it('refuses a rejected slip, and writes nothing', async () => {
    const { je, bt } = await seedProvisional();
    const doc = await seedDoc(company, { status: 'rejected' });

    const out = await attach(je, doc);

    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(/rejected/i);
    expect(await docPostedAt(doc)).toBeNull();
    expect((await jeState(je)).needs_evidence).toBe(true);
    expect(await btStatus(bt)).toBe('provisional');
  });

  it("answers 404 for another company's slip, and claims nothing", async () => {
    const { je, bt } = await seedProvisional();
    const foreign = await seedDoc(otherCompany);

    const out = await attach(je, foreign);

    expect(out.statusCode, JSON.stringify(out.body)).toBe(404);
    expect(await docPostedAt(foreign)).toBeNull();
    expect((await jeState(je)).needs_evidence).toBe(true);
    expect(await btStatus(bt)).toBe('provisional');
  });

  it('refuses a journal that is already evidenced, and claims nothing', async () => {
    const { je } = await seedProvisional({ evidenced: true });
    const doc = await seedDoc(company);

    const out = await attach(je, doc);

    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(await docPostedAt(doc)).toBeNull();
  });

  it('refuses a reversed provisional journal, and claims nothing', async () => {
    const { je } = await seedProvisional({ reversed: true });
    const doc = await seedDoc(company);

    const out = await attach(je, doc);

    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(/reversed/i);
    expect(await docPostedAt(doc)).toBeNull();
    expect((await jeState(je)).source_document_id).toBeNull();
  });

  it('answers 400 for ids that are not uuids', async () => {
    const { je } = await seedProvisional();
    expect((await attach(je, 'not-a-uuid')).statusCode).toBe(400);
    expect((await attach('not-a-uuid', crypto.randomUUID())).statusCode).toBe(400);
  });

  it('one slip raced onto two journals lands on exactly one', async () => {
    const a = await seedProvisional();
    const b = await seedProvisional();
    const doc = await seedDoc(company);

    const [x, y] = await Promise.all([attach(a.je, doc), attach(b.je, doc)]);

    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 400]);
    expect(await journalsFor(doc)).toBe(1);
    const evidenced = [await jeState(a.je), await jeState(b.je)].filter((s) => !s.needs_evidence);
    expect(evidenced).toHaveLength(1);
  });

  it('two slips raced onto one journal: one wins, and the loser stays unclaimed', async () => {
    const { je } = await seedProvisional();
    const d1 = await seedDoc(company);
    const d2 = await seedDoc(company);

    const [x, y] = await Promise.all([attach(je, d1), attach(je, d2)]);

    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 400]);
    const winner = (await jeState(je)).source_document_id;
    const loser = winner === d1 ? d2 : d1;
    expect([d1, d2]).toContain(winner);
    expect(await docPostedAt(winner!)).not.toBeNull();
    expect(await docPostedAt(loser)).toBeNull();
  });
});
