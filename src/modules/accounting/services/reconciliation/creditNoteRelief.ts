/**
 * How much a credit note took off ONE document, for the control-account scan.
 *
 * ── WHY THE ROWS, NOT THE COLUMN ────────────────────────────────────────────
 *
 * This leg used to read `SUM(credit_notes.applied_amount)` over the notes the
 * single link column names — `cn.customer_invoice_id = ci.id` on AR,
 * `cn.supplier_invoice_id = si.id` on AP. That shape assumes a note settles at
 * most one document, and since migration 677 it does not: `applyCreditNote`
 * settles the linked document first and then walks the entity's other open
 * documents oldest first, writing one `credit_note_allocations` row per pair,
 * and `applied_amount` became the SUM of those rows.
 *
 * So the old read attributed a note spread over N bills WHOLLY to the one bill
 * it links to — and a note with no link to nothing at all — while every other
 * bill it settled looked unrelieved. On a production copy after the 677
 * back-fill, AP for one company reported `document_not_on_control_account` of
 * −R3,728,724.75 over 150 documents, offset to the cent by an
 * `unexplained_difference` of +R3,728,724.79: every figure internally
 * consistent, none of it a fact about the books. The true residual was R0.04.
 *
 * `shared/agingRewind.ts` reads the same fact for the aged reports, and this is
 * deliberately the same two-arm shape — rows first, the pre-677 column behind a
 * NOT EXISTS — so the two reports cannot disagree about what a note settled.
 *
 * ── THE CAP, AND WHY IT IS PROPORTIONAL ─────────────────────────────────────
 *
 * A document may only be relieved by credit that actually REACHED the control
 * account, which is the cap the column-based leg already carried: a note whose
 * journal is unposted, dated after the as-at date, or posted somewhere other
 * than a control account has relieved nothing there, however much
 * `applied_amount` says it consumed. Counting it anyway makes the document read
 * as under-represented and drops the same value into the residual.
 *
 * With one note over several documents a flat `LEAST(allocated, control)` per
 * document is NOT that cap — a note whose journal put R60 on the control
 * account but which allocated R50 to each of two bills would relieve R100,
 * because the cap binds on neither bill alone. Each allocation therefore takes
 * its own SHARE of the note's control movement: `allocated × control / Σ
 * allocated`, capped at the allocation. Where the journal covers the note in
 * full — the ordinary case — the ratio is at or above 1 and the allocation
 * passes through untouched.
 *
 * `NULLIF(tot, 0)` cannot bite in practice (`amount_allocated > 0` is a CHECK,
 * so a note with a row has a positive total) and is there because LEAST ignores
 * NULL: were the sum ever zero the allocation is zero too and the relief is
 * zero, rather than a division error.
 */

import { sql } from '@/lib/neon';

export interface CreditNoteReliefInput {
  companyId: string;
  /** Inclusive as-at date, 'YYYY-MM-DD'. */
  asAtDate: string;
  /** Every resolved control account id. */
  ids: string[];
  side: 'ar' | 'ap';
}

/**
 * A correlated expression: the credit a document has been relieved by, as at
 * the date, for the invoice aliased `ci` (AR) or `si` (AP) in the surrounding
 * query. Positive. The caller SUBTRACTS it from the document's control amount.
 */
export function creditNoteReliefExpr({ companyId, asAtDate, ids, side }: CreditNoteReliefInput) {
  const isAr = side === 'ar';
  const invoice = isAr ? 'ci' : 'si';
  const creditLink = isAr ? 'customer_invoice_id' : 'supplier_invoice_id';
  const creditType = isAr ? 'customer' : 'supplier';
  // The signed movement a note puts on a control account: a customer note
  // CREDITS the receivable, a supplier note DEBITS the payable.
  const controlMovement = isAr ? 'jl.credit - jl.debit' : 'jl.debit - jl.credit';

  // `cn.type` is the discriminator migration 677 requires of every read:
  // `credit_note_allocations.invoice_id` points at customer_invoices for a
  // customer note and supplier_invoices for a supplier one, and no single
  // foreign key can span both.
  const fromRows = sql`
        SELECT SUM(LEAST(
                 cna.amount_allocated,
                 cna.amount_allocated * ctrl.amount / NULLIF(tot.amount, 0)
               ))
        FROM credit_note_allocations cna
        JOIN credit_notes cn ON cn.id = cna.credit_note_id
                            AND cn.company_id = ${companyId}::UUID
                            AND cn.type = ${creditType}
                            AND COALESCE(cn.status, '') <> 'cancelled'
        CROSS JOIN LATERAL (
          SELECT COALESCE(SUM(${sql.unsafe(controlMovement)}), 0) AS amount
          FROM gl_journal_entries je
          JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
                                  AND jl.company_id = ${companyId}::UUID
                                  AND jl.gl_account_id = ANY(${ids}::uuid[])
          WHERE je.id = cn.gl_journal_entry_id
            AND je.company_id = ${companyId}::UUID
            AND je.status = 'posted'
            AND je.entry_date <= ${asAtDate}::DATE
        ) ctrl
        CROSS JOIN LATERAL (
          SELECT COALESCE(SUM(cna2.amount_allocated), 0) AS amount
          FROM credit_note_allocations cna2
          WHERE cna2.credit_note_id = cn.id
            AND cna2.company_id = ${companyId}::UUID
        ) tot
        WHERE cna.invoice_id = ${sql.unsafe(`${invoice}.id`)}
          AND cna.company_id = ${companyId}::UUID`;

  // THE PRE-677 SHAPE, and it is not only history: a note carrying
  // `applied_amount` with no allocation row can only have credited the ONE
  // document it names, and that is exactly what this reads. NOT EXISTS is what
  // stops a note that HAS rows being counted twice — the rows are authoritative
  // the moment there are any. This mirrors `rewindAmount`'s legacy arm; drop it
  // and every note the 677 back-fill could not attribute silently stops
  // relieving the document it settled.
  //
  // The cap here is the flat one, and correctly so: with no allocation rows the
  // note's whole applied amount is against this one document, so the note's
  // control movement is the share.
  const fromLink = sql`
        SELECT LEAST(
                 COALESCE((
                   SELECT SUM(cn.applied_amount)
                   FROM credit_notes cn
                   WHERE cn.company_id = ${companyId}::UUID
                     AND cn.${sql.unsafe(creditLink)} = ${sql.unsafe(`${invoice}.id`)}
                     AND cn.type = ${creditType}
                     AND COALESCE(cn.status, '') <> 'cancelled'
                     AND EXISTS (
                       SELECT 1 FROM gl_journal_entries je
                       WHERE je.id = cn.gl_journal_entry_id
                         AND je.company_id = ${companyId}::UUID
                         AND je.status = 'posted'
                         AND je.entry_date <= ${asAtDate}::DATE
                     )
                     AND NOT EXISTS (
                       SELECT 1 FROM credit_note_allocations cna2
                       WHERE cna2.credit_note_id = cn.id
                     )
                 ), 0),
                 COALESCE((
                   SELECT SUM(${sql.unsafe(controlMovement)})
                   FROM credit_notes cn
                   JOIN gl_journal_entries je ON je.id = cn.gl_journal_entry_id
                                             AND je.company_id = ${companyId}::UUID
                                             AND je.status = 'posted'
                                             AND je.entry_date <= ${asAtDate}::DATE
                   JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
                                           AND jl.company_id = ${companyId}::UUID
                                           AND jl.gl_account_id = ANY(${ids}::uuid[])
                   WHERE cn.company_id = ${companyId}::UUID
                     AND cn.${sql.unsafe(creditLink)} = ${sql.unsafe(`${invoice}.id`)}
                     AND cn.type = ${creditType}
                     AND COALESCE(cn.status, '') <> 'cancelled'
                     AND NOT EXISTS (
                       SELECT 1 FROM credit_note_allocations cna2
                       WHERE cna2.credit_note_id = cn.id
                     )
                 ), 0)
               )`;

  return sql`COALESCE((${fromRows}), 0) + COALESCE((${fromLink}), 0)`;
}
