/**
 * Importer ≠ allocator (forensic-controls step 2; Hein's decision 2, 2026-10-09).
 *
 * A line from an imported statement is bank evidence (R-035 PR5's D2) — but
 * only because someone other than the person allocating it vouched for the
 * file. Under enforcement of the arm's type — `manual_journal` for account,
 * split and transfer, `supplier_payment` (coupled with `payment_batch`) for a
 * supplier outflow — the person recorded as the importer of a line's
 * `import_batch_id` (bank_import_batches.imported_by, fixed once set by 877)
 * may not allocate that line on those arms, unless they are the sole approver
 * on the admin floor (R-035 Q2). Feed lines (`bank_feed_connection_id`) and
 * money IN (receipts, supplier refunds) are unaffected; a line with no batch
 * row, or a legacy `mcp:*` importer, names no person and is not held.
 *
 * Raised before any write, from the locked line where the site holds one.
 * Callers: allocateTransaction and splitAllocateTransaction (throw), the
 * rule sweep and the provisional poster (a counted `approval_required` skip),
 * the MCP bulk classifier (a skip, so the dry run agrees), the MCP split and
 * apply-supplier-payment pre-checks, and the bank-first provisional claim.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { BankControlError, isSoleAtFloor } from './bankControlRefusal';
import { coupledTypes, isEnforced } from '../gl/approvalEnforcement';

/** The approval type an allocation (or its reversal) is judged under. */
export type BankArm = 'manual_journal' | 'supplier_payment';

const LABEL: Record<BankArm, string> = { manual_journal: 'manual-journal', supplier_payment: 'supplier-payment' };
export const armLabel = (arm: BankArm): string => LABEL[arm];

type Provenance = { import_batch_id?: unknown; bank_feed_connection_id?: unknown };

/** Whether `arm`'s type is enforced — for supplier payments, either coupled switch. */
export async function armEnforced(companyId: string, arm: BankArm): Promise<boolean> {
  for (const type of coupledTypes(arm)) if (await isEnforced(companyId, type)) return true;
  return false;
}

/**
 * The arm an allocation posts on — the ONE mapping every importer check uses
 * (the service, the rule sweep, the provisional poster, the MCP classifier).
 * Account and transfer, and a supplier/customer allocation naming no contact
 * (allocateTransaction posts it to the account; a rule, to the control
 * account), are a journal. Money in with a contact (a receipt, a supplier
 * refund) is ungated. Money OUT with a contact is a payment: to a supplier,
 * `supplier_payment`; to a customer (a refund) no payment type exists, so it
 * is the journal a person composed — `manual_journal`, failing closed.
 */
export function importerArmOf(allocType: string, entityId: string | null | undefined, signedAmount: number): BankArm | null {
  if (allocType === 'account' || allocType === 'transfer' || !entityId) return 'manual_journal';
  if (signedAmount >= 0) return null;
  return allocType === 'supplier' ? 'supplier_payment' : 'manual_journal';
}

/** The system user: a sweep run for nobody (bankImportService's poster). */
const NOBODY = '00000000-0000-0000-0000-000000000000';
/** User ids compared as the importer and allocator checks compare them: case-insensitively. */
export const sameUser = (x: unknown, y: string) => String(x).toLowerCase() === y.toLowerCase();

/**
 * R-035 Q2 on the admin floor, asked only on the request's own behalf:
 * approval_company_other_members refuses any other user (42501), and a refused
 * statement would poison the transaction — so an actor who is not the
 * request's own user (a job, a sweep run for nobody) is never sole.
 */
export async function isSoleAsCaller(companyId: string, actorUserId: string): Promise<boolean> {
  const [row] = (await sql`SELECT auth.uid()::TEXT AS uid`) as DbRow[];
  if (row?.uid == null || !sameUser(row.uid, actorUserId)) return false;
  return isSoleAtFloor(companyId, String(row.uid));
}

function refusal(arm: BankArm): BankControlError {
  return new BankControlError('IMPORTER_MAY_NOT_ALLOCATE',
    `You imported this bank statement, so while ${LABEL[arm]} approval is on you cannot allocate its lines yourself. `
    + 'Ask another member to allocate this line.');
}

/** The refusal for `actorUserId` allocating `line` on `arm`, or null. Reads only. */
export async function importerAllocationRefusal(
  companyId: string, line: Provenance, actorUserId: string, arm: BankArm,
): Promise<BankControlError | null> {
  if (line.import_batch_id == null || line.bank_feed_connection_id != null) return null;
  if (!(await armEnforced(companyId, arm))) return null;
  const [batch] = (await sql`
    SELECT imported_by FROM bank_import_batches
    WHERE id = ${String(line.import_batch_id)}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (batch?.imported_by == null || String(batch.imported_by).startsWith('mcp:')) return null; // no person on record
  // An actor of nobody (a sweep that named no person) cannot show it was not run for the importer: held, failing closed.
  if (actorUserId !== NOBODY && !sameUser(batch.imported_by, actorUserId)) return null;
  return (await isSoleAsCaller(companyId, actorUserId)) ? null : refusal(arm);
}

/** Throws the refusal unless `actorUserId` may allocate `line` (the locked row) on `arm`. */
export async function assertImporterMayAllocate(
  companyId: string, line: Provenance, actorUserId: string, arm: BankArm,
): Promise<void> {
  const refused = await importerAllocationRefusal(companyId, line, actorUserId, arm);
  if (refused) throw refused;
}

/** assertImporterMayAllocate on the arm `allocType` posts on (importerArmOf) — allocateTransaction's one call. */
export async function assertImporterMayAllocateAs(
  companyId: string, line: Provenance & { amount?: unknown }, actorUserId: string, allocType: string, entityId?: string | null,
): Promise<void> {
  const arm = importerArmOf(allocType, entityId, Number(line.amount));
  if (arm) await assertImporterMayAllocate(companyId, line, actorUserId, arm);
}

/**
 * Matching a statement line to a journal books the line's cash to that
 * journal's accounts — the same ledger result as allocating it. So under
 * manual_journal enforcement the importer may not match their own batch's line
 * to a journal THEY created (case-insensitive), sole approver excepted; a
 * journal someone else created stays matchable. Unlocked reads: a line's
 * provenance and a journal's creator never change. Throws the 403.
 */
export async function assertImporterMayMatch(
  companyId: string, bankTxId: string, journalLineId: string, actorUserId: string,
): Promise<void> {
  const [row] = (await sql`
    SELECT bt.import_batch_id, bt.bank_feed_connection_id, je.created_by::TEXT AS journal_by
    FROM bank_transactions bt
    LEFT JOIN gl_journal_lines jl ON jl.id = ${journalLineId}::UUID AND jl.company_id = bt.company_id
    LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = bt.company_id
    WHERE bt.id = ${bankTxId}::UUID AND bt.company_id = ${companyId}::UUID
  `) as DbRow[];
  if (row?.journal_by == null || !sameUser(row.journal_by, actorUserId)) return;
  await assertImporterMayAllocate(companyId, row, actorUserId, 'manual_journal');
}

/**
 * Auto-match's twin of assertImporterMayMatch: the run acts for the person who
 * triggered it (A3), so under manual_journal enforcement the bank lines among
 * `pairs` that person imported AND whose journal they created are held —
 * skipped and counted, never matched; sole approver excepted. One read per run.
 */
export async function importerHeldMatchPairs(companyId: string, actorUserId: string,
  pairs: readonly { bankTransactionId: string; journalLineId: string }[]): Promise<Set<string>> {
  if (pairs.length === 0 || !(await armEnforced(companyId, 'manual_journal'))) return new Set();
  const own = new Set(((await sql`
    SELECT bt.id FROM unnest(${pairs.map((p) => p.bankTransactionId)}::UUID[], ${pairs.map((p) => p.journalLineId)}::UUID[]) AS p(tx, jl)
    JOIN bank_transactions bt ON bt.id = p.tx AND bt.company_id = ${companyId}::UUID
    JOIN bank_import_batches b ON b.id = bt.import_batch_id AND b.company_id = bt.company_id
    JOIN gl_journal_lines jl ON jl.id = p.jl AND jl.company_id = bt.company_id
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = bt.company_id
    WHERE bt.bank_feed_connection_id IS NULL
      AND lower(b.imported_by) = lower(${actorUserId}) AND lower(je.created_by::TEXT) = lower(${actorUserId})
  `) as DbRow[]).map((r) => String(r.id)));
  return own.size === 0 || await isSoleAsCaller(companyId, actorUserId) ? new Set() : own;
}

/** importerAllocationRefusal for a line by id, company-scoped (an MCP pre-check, unlocked); null when there is no such line. */
export async function importerRefusalForLineId(
  companyId: string, bankTxId: string, actorUserId: string, arm: BankArm,
): Promise<BankControlError | null> {
  const [line] = (await sql`
    SELECT import_batch_id, bank_feed_connection_id FROM bank_transactions
    WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return line ? importerAllocationRefusal(companyId, line, actorUserId, arm) : null;
}

/**
 * The MCP bulk classifier's twin: txId → `approval_required: <why>` for each
 * line `actorUserId` imported and would allocate on an enforced arm. One read
 * of the lines' importers for the whole batch; empty while no arm is enforced.
 */
export async function importerHeldLineSkips(companyId: string, actorUserId: string,
  lines: readonly { txId: string; arm: BankArm }[]): Promise<Map<string, string>> {
  const skips = new Map<string, string>();
  const enforced = new Map<BankArm, boolean>();
  for (const arm of new Set(lines.map((l) => l.arm))) enforced.set(arm, await armEnforced(companyId, arm));
  const gated = lines.filter((l) => enforced.get(l.arm));
  if (gated.length === 0) return skips;
  const own = new Set(((await sql`
    SELECT bt.id FROM bank_transactions bt
    JOIN bank_import_batches b ON b.id = bt.import_batch_id AND b.company_id = bt.company_id
    WHERE bt.company_id = ${companyId}::UUID AND bt.id = ANY(${gated.map((l) => l.txId)}::UUID[])
      AND bt.bank_feed_connection_id IS NULL AND b.imported_by IS NOT NULL AND b.imported_by NOT LIKE 'mcp:%'
      AND (lower(b.imported_by) = lower(${actorUserId}) OR ${actorUserId === NOBODY}::BOOLEAN)
  `) as DbRow[]).map((r) => String(r.id)));
  if (own.size === 0 || await isSoleAsCaller(companyId, actorUserId)) return skips;
  for (const line of gated) if (own.has(line.txId)) skips.set(line.txId, `approval_required: ${refusal(line.arm).message}`);
  return skips;
}
