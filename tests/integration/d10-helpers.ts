/**
 * D10 (subledger vs GL drift) — shared fixture for the d10-*.int.test.ts files on the d8-r4 fixture (isaflow_test).
 *
 * `chainDoc` builds ONE document — a supplier payment, a customer receipt or a payment batch — on a bill/invoice of
 * R400, reverses its journal O k times through the product (O <- R1 <- ... <- Rk), and matches a statement line to
 * each chosen chain position (0 = O, k = the head). `state()` reads every half the D10 invariant compares: the
 * document (and batch members), the bill/invoice, the chain, and every line.
 */
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { approveBatch, createBatch, processBatch } from '@/modules/accounting/services/ap/batchPaymentService';
import { findJournalChainHead } from '@/modules/accounting/services/shared/journalChainHead';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { inTx } from './helpers/l1FifoFixture';
import { buildChain, confirmedReceipt, postedBill, postedInvoice, processedPayment, setup, type Ctx } from './d8-r4-helpers';

type Row = Record<string, unknown>;
export type Side = 'ap' | 'ar' | 'batch';
export type Handler = (req: never, res: never) => unknown;
export const AMOUNT = 400;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;

/** The d8-r4 fixture plus a user who can call the real routes (withAuth, JWT). */
export async function setupWithUser(prefix: string): Promise<{ c: Ctx; token: string }> {
  const c = await setup(prefix);
  await sql`INSERT INTO users (id, email, first_name) VALUES (${c.fx.userId}, ${`${prefix.toLowerCase()}-${c.fx.tag}@example.invalid`}, 'd10')
            ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${c.fx.companyId}::UUID, ${c.fx.userId}, 'admin')`;
  const token = await new SignJWT({ sub: c.fx.userId, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return { c, token };
}

/** Undo what setupWithUser and the batch builder add beyond the d8-r4 fixture, so `teardown` can drop it. */
export async function clearExtras(c: Ctx | undefined): Promise<void> {
  if (!c) return;
  await sql`UPDATE bank_transactions SET matched_journal_line_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
  await sql`UPDATE supplier_payments SET batch_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
  await sql`DELETE FROM supplier_payment_batches WHERE company_id = ${c.fx.companyId}::UUID`;
  await sql`DELETE FROM company_users WHERE company_id = ${c.fx.companyId}::UUID`;
}

export async function callRoute(c: Ctx, token: string, route: Handler, body: Record<string, unknown>) {
  const req = request({ 'sb-access-token': token, active_company_id: c.fx.companyId }, 'POST') as unknown as Row;
  req.body = body;
  const out = response();
  await route(req as never, out.res as never);
  return { status: out.state.statusCode, body: JSON.stringify(out.state.body ?? null) };
}

export async function chainState(c: Ctx, root: string): Promise<'standing' | 'out' | 'broken'> {
  const h = await findJournalChainHead(c.fx.companyId, root);
  if (!h) return 'out';
  if (h.kind === 'broken') return 'broken';
  return h.standing ? 'standing' : 'out';
}

/** The bank leg of journal `je`. */
export const bankLegOf = async (c: Ctx, je: string) => String((await one(sql`
  SELECT id FROM gl_journal_lines WHERE journal_entry_id = ${je}::UUID AND gl_account_id = ${c.fx.bankAccountId}::UUID LIMIT 1`)).id);

/** A statement line matched to journal `je`'s bank leg (`status` 'matched' or 'reconciled'). */
export async function lineOn(c: Ctx, je: string, amount: number, status = 'matched'): Promise<string> {
  return String((await one(sql`
    INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status, matched_journal_line_id)
    VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2026-05-20', ${amount}, ${`D10 ${++c.seq}`}, ${status},
            ${await bankLegOf(c, je)}::UUID) RETURNING id`)).id);
}

export interface ChainDoc {
  side: Side; docId: string; payId: string; billOrInv: string; chain: string[];
  /** Statement line per chain position matched. */
  lines: Map<number, string>;
}

/** A document on a R400 bill/invoice, its journal reversed k times, lines matched at `positions` (0..k). */
export async function chainDoc(c: Ctx, side: Side, k: number, positions: number[]): Promise<ChainDoc> {
  const id = c.fx.companyId, u = c.fx.userId;
  let docId: string, payId: string, je: string, billOrInv: string;
  if (side === 'ap') {
    const b = await postedBill(c); billOrInv = b.id;
    const p = await processedPayment(c, b.id, AMOUNT); docId = payId = p.id; je = p.je;
  } else if (side === 'ar') {
    const i = await postedInvoice(c); billOrInv = i.id;
    const r = await confirmedReceipt(c, i.id, AMOUNT); docId = payId = r.id; je = r.je;
  } else {
    const b = await postedBill(c); billOrInv = b.id;
    docId = await inTx(c.fx, async () => {
      const bt = await createBatch(id, { batchDate: '2026-05-20', bankAccountId: c.fx.bankAccountId,
        payments: [{ supplierId: c.fx.supplierId, invoiceAllocations: [{ invoiceId: b.id, amount: AMOUNT }] }] }, u);
      await approveBatch(id, bt.id, u);
      await processBatch(id, bt.id, u);
      return bt.id;
    });
    const r = await one(sql`SELECT b.gl_journal_entry_id AS je, p.id AS pay FROM supplier_payment_batches b
      JOIN supplier_payments p ON p.batch_id = b.id WHERE b.id = ${docId}::UUID`);
    je = String(r.je); payId = String(r.pay);
  }
  const chain = await buildChain(c, je, k);
  const lines = new Map<number, string>();
  // The document's bank leg is cash out (AP, batch) / in (AR); each reversal flips the sign.
  for (const p of positions) lines.set(p, await lineOn(c, chain[p]!, (side === 'ar' ? AMOUNT : -AMOUNT) * (p % 2 === 0 ? 1 : -1)));
  return { side, docId, payId, billOrInv, chain, lines };
}

/** Every half of the invariant, read back. */
export async function docState(c: Ctx, d: ChainDoc) {
  const doc = String((await one(d.side === 'ar'
    ? sql`SELECT status FROM customer_payments WHERE id = ${d.payId}::UUID`
    : d.side === 'ap' ? sql`SELECT status FROM supplier_payments WHERE id = ${d.payId}::UUID`
      : sql`SELECT status FROM supplier_payment_batches WHERE id = ${d.docId}::UUID`)).status);
  const member = d.side === 'batch'
    ? String((await one(sql`SELECT status FROM supplier_payments WHERE id = ${d.payId}::UUID`)).status) : null;
  const paid = Number((await one(d.side === 'ar'
    ? sql`SELECT amount_paid::float8 AS p FROM customer_invoices WHERE id = ${d.billOrInv}::UUID`
    : sql`SELECT amount_paid::float8 AS p FROM supplier_invoices WHERE id = ${d.billOrInv}::UUID`)).p);
  const lines = (await sql`SELECT id::TEXT AS id, status, matched_journal_line_id IS NOT NULL AS matched
    FROM bank_transactions WHERE id = ANY(${[...d.lines.values()]}::UUID[]) ORDER BY id`) as Row[];
  return { doc, member, paid, chain: await chainState(c, d.chain[0]!), lines };
}

/** The document is OUT: cancelled / reversed, bill or invoice back to 0, chain out, every line free. */
export function expectOut(s: Awaited<ReturnType<typeof docState>>): string | null {
  const errs: string[] = [];
  if (!['cancelled', 'reversed'].includes(s.doc)) errs.push(`doc ${s.doc}`);
  if (s.member !== null && s.member !== 'cancelled') errs.push(`member ${s.member}`);
  if (s.paid !== 0) errs.push(`paid ${s.paid}`);
  if (s.chain !== 'out') errs.push(`chain ${s.chain}`);
  for (const l of s.lines) if (l.status !== 'imported' || l.matched) errs.push(`line ${String(l.id).slice(0, 8)} ${String(l.status)}`);
  return errs.length ? errs.join('; ') : null;
}
