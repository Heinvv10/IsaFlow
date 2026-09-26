/**
 * Mark / unmark an issued customer invoice or approved bill "VAT declared
 * outside IsaFlow / historical import" (migration 705).
 *
 * REPLACES a "post to GL" action, which vatUnpostedInvoices.ts's own docs
 * call out as unsafe: an imported document may already carry its VAT in the
 * GL under a different entry, or have declared it under the old system, so
 * posting it now could double the VAT. This mark does neither — it never
 * touches the GL and never changes a VAT201 field. It only moves the
 * document from the BLOCKING unposted list to a visible, NON-blocking
 * "declared elsewhere" list (vatUnpostedInvoices.findVatDeclaredElsewhere).
 *
 * Owner/admin only, with a reason — same threshold as unlockVatPeriod and
 * vatGateOverrideService. Unmarking restores the block, also owner/admin
 * with a reason.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { logAuditOrThrow } from '../core/auditTrailService';
import { isEligibleForVatDeclaredElsewhereMark } from './vatUnpostedInvoices';

export type VatDocKind = 'customer' | 'supplier';

const OVERRIDE_ROLES: readonly string[] = ['owner', 'admin', 'super_admin'];

/** Owner/admin only. Maps to 403 — pre-write. */
export class VatDeclaredElsewhereForbiddenError extends Error {
  readonly code = 'VAT_DECLARED_ELSEWHERE_FORBIDDEN';
  constructor() {
    super('Only an owner or admin can mark or unmark VAT declared outside IsaFlow.');
    this.name = 'VatDeclaredElsewhereForbiddenError';
  }
}

/** No such document in this company, a blank reason, or an unmark of a document not marked. Maps to 400 — pre-write. */
export class VatDeclaredElsewhereRefusal extends Error {
  readonly code = 'VAT_DECLARED_ELSEWHERE_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'VatDeclaredElsewhereRefusal';
  }
}

function table(kind: VatDocKind): 'customer_invoices' | 'supplier_invoices' {
  return kind === 'customer' ? 'customer_invoices' : 'supplier_invoices';
}

function entityType(kind: VatDocKind): 'customer_invoice' | 'supplier_invoice' {
  return kind === 'customer' ? 'customer_invoice' : 'supplier_invoice';
}

function assertOverrideRole(role: string): void {
  if (!OVERRIDE_ROLES.includes(role)) throw new VatDeclaredElsewhereForbiddenError();
}

export interface VatDeclaredElsewhereActor {
  userId: string;
  role: string;
}

export interface MarkResult {
  invoiceId: string;
  marked: boolean;
}

/**
 * Mark one document. Idempotent: marking an already-marked document with a
 * new reason simply updates it (never two rows, there is only one).
 */
export async function markVatDeclaredElsewhere(
  companyId: string,
  kind: VatDocKind,
  invoiceId: string,
  actor: VatDeclaredElsewhereActor,
  reason: string,
): Promise<MarkResult> {
  assertOverrideRole(actor.role);
  const why = reason.trim();
  if (!why) throw new VatDeclaredElsewhereRefusal('A reason is required to mark VAT declared outside IsaFlow.');

  // Breaker fix (2026-09-26): only a document whose VAT has NEVER reached the
  // GL may be marked. Reuses vatUnpostedInvoices.ts's own population
  // predicate (one source of truth) — a document that is not currently in
  // the blocking unposted-invoice-VAT list, OR whose gl_journal_entry_id
  // points at a journal that is or was posted (including a posted-then-
  // reversed one), is refused BEFORE any write.
  if (!(await isEligibleForVatDeclaredElsewhereMark(companyId, kind, invoiceId))) {
    throw new VatDeclaredElsewhereRefusal(
      `${kind === 'customer' ? 'Customer invoice' : 'Supplier invoice'} is not eligible to be marked "VAT declared outside IsaFlow": `
      + 'its VAT is not currently unposted, or it has already reached the general ledger (even if that journal was later reversed).',
    );
  }

  const tbl = table(kind);
  const rows = (kind === 'customer'
    ? await sql`
        UPDATE customer_invoices
        SET vat_declared_elsewhere_at = now(), vat_declared_elsewhere_by = ${actor.userId}::TEXT,
            vat_declared_elsewhere_reason = ${why}
        WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
        RETURNING id
      `
    : await sql`
        UPDATE supplier_invoices
        SET vat_declared_elsewhere_at = now(), vat_declared_elsewhere_by = ${actor.userId}::TEXT,
            vat_declared_elsewhere_reason = ${why}
        WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
        RETURNING id
      `) as DbRow[];

  // One answer for absent and foreign — no existence oracle across tenants.
  if (!rows[0]) throw new VatDeclaredElsewhereRefusal(`${tbl === 'customer_invoices' ? 'Customer invoice' : 'Supplier invoice'} not found.`);

  await logAuditOrThrow({
    companyId, userId: actor.userId, action: 'update', entityType: entityType(kind), entityId: invoiceId,
    changes: {
      fields: [{ field: 'vat_declared_elsewhere', old: null, new: why, label: 'VAT declared outside IsaFlow' }],
    },
  });
  log.info('VAT declared elsewhere marked', { companyId, kind, invoiceId }, 'vatDeclaredElsewhereService');
  return { invoiceId, marked: true };
}

/**
 * Bulk mark — one row per id, same actor/reason. ALL ids are validated for
 * eligibility BEFORE any of them is written: a 4xx refusal here still commits
 * whatever came before it (withAuth rolls back only on >=500), so a mid-batch
 * refusal must never be allowed to follow a mid-batch write.
 */
export async function markVatDeclaredElsewhereBulk(
  companyId: string,
  kind: VatDocKind,
  invoiceIds: string[],
  actor: VatDeclaredElsewhereActor,
  reason: string,
): Promise<MarkResult[]> {
  assertOverrideRole(actor.role);
  for (const id of invoiceIds) {
    if (!(await isEligibleForVatDeclaredElsewhereMark(companyId, kind, id))) {
      throw new VatDeclaredElsewhereRefusal(
        `${kind === 'customer' ? 'Customer invoice' : 'Supplier invoice'} ${id} is not eligible to be marked "VAT declared outside IsaFlow": `
        + 'its VAT is not currently unposted, or it has already reached the general ledger (even if that journal was later reversed).',
      );
    }
  }
  const results: MarkResult[] = [];
  for (const id of invoiceIds) {
    results.push(await markVatDeclaredElsewhere(companyId, kind, id, actor, reason));
  }
  return results;
}

/** Unmark — restores the block. Refuses a document that is not currently marked. */
export async function unmarkVatDeclaredElsewhere(
  companyId: string,
  kind: VatDocKind,
  invoiceId: string,
  actor: VatDeclaredElsewhereActor,
  reason: string,
): Promise<MarkResult> {
  assertOverrideRole(actor.role);
  const why = reason.trim();
  if (!why) throw new VatDeclaredElsewhereRefusal('A reason is required to unmark VAT declared outside IsaFlow.');

  const rows = (kind === 'customer'
    ? await sql`
        UPDATE customer_invoices
        SET vat_declared_elsewhere_at = NULL, vat_declared_elsewhere_by = NULL, vat_declared_elsewhere_reason = NULL
        WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
          AND vat_declared_elsewhere_at IS NOT NULL
        RETURNING id
      `
    : await sql`
        UPDATE supplier_invoices
        SET vat_declared_elsewhere_at = NULL, vat_declared_elsewhere_by = NULL, vat_declared_elsewhere_reason = NULL
        WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
          AND vat_declared_elsewhere_at IS NOT NULL
        RETURNING id
      `) as DbRow[];

  if (!rows[0]) throw new VatDeclaredElsewhereRefusal('This document is not marked VAT declared outside IsaFlow (or was not found).');

  await logAuditOrThrow({
    companyId, userId: actor.userId, action: 'update', entityType: entityType(kind), entityId: invoiceId,
    changes: {
      fields: [{ field: 'vat_declared_elsewhere', old: 'marked', new: null, label: 'VAT declared outside IsaFlow (unmarked)' }],
      metadata: { reason: why },
    },
  });
  log.info('VAT declared elsewhere unmarked', { companyId, kind, invoiceId }, 'vatDeclaredElsewhereService');
  return { invoiceId, marked: false };
}
