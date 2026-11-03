/**
 * Assigning budget holders (budgets P5-6, spec §3f, decision 9a). An owner or admin names a member
 * who is a manager, admin or owner as the holder of one slice (company level, or one CC1, CC2 or
 * BU member) of a DRAFT version, optionally limited to some accounts, with a due date. That creates
 * the slice's review row ('open') when it has none; assigning again updates the holder's accounts
 * and, when a due date is given, the slice's due date (its status stays). Migration 955 holds the
 * same rules in the database (budget_holders_rules, budget_slice_reviews_rules).
 * One audit row (entity 'budget', the version); the holder is told in the bell.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow } from '../core/auditTrailService';
import { notifyUsers } from '../notifications/userNotificationService';
import { BudgetVersionError } from './budgetVersionTypes';
import { getVersion } from './budgetVersions';
import { inputError } from './gridErrors';
import { readSlice, type SliceReview } from './sliceReviewRead';

export interface AssignHolderInput {
  versionId: string;
  userId: string;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
  /** null: every account of the slice. */
  glAccountIds: string[] | null;
  /** 'YYYY-MM-DD' or null. */
  dueDate: string | null;
}

export const HOLDER_ROLES: readonly string[] = ['owner', 'admin', 'manager'];
export const MAX_HOLDER_ACCOUNTS = 1000;

export async function assignHolder(
  companyId: string, actor: { userId: string; role: string }, input: AssignHolderInput,
): Promise<SliceReview> {
  if (actor.role !== 'owner' && actor.role !== 'admin') {
    throw new BudgetVersionError('BUDGET_SLICE_FORBIDDEN', 'Only an owner or admin can assign budget holders');
  }
  const dims = [input.cc1Id, input.cc2Id, input.buId].filter((d) => d !== null).length;
  if (dims > 1) throw inputError('A budget slice is company level or ONE dimension (CC1, CC2 or BU)');
  const version = await getVersion(companyId, input.versionId);
  if (version.status !== 'draft') {
    throw new BudgetVersionError('BUDGET_SLICE_STATE', `Budget holders are assigned on a draft version only; this version is ${version.status}`);
  }
  await checkHolder(companyId, input.userId);
  await checkSliceMembers(companyId, input);
  const accounts = input.glAccountIds === null ? null : [...new Set(input.glAccountIds.map((a) => a.toLowerCase()))];
  if (accounts !== null) await checkAccounts(companyId, accounts);

  await sql`
    INSERT INTO budget_holders (company_id, version_id, user_id, cc1_id, cc2_id, bu_id, gl_account_ids, created_by)
    VALUES (${companyId}::UUID, ${input.versionId}::UUID, ${input.userId}, ${input.cc1Id}::UUID, ${input.cc2Id}::UUID,
            ${input.buId}::UUID, ${accounts}::UUID[], ${actor.userId})
    ON CONFLICT ON CONSTRAINT budget_holders_one_per_slice DO UPDATE SET gl_account_ids = EXCLUDED.gl_account_ids
  `;
  const slice = (await sql`
    INSERT INTO budget_slice_reviews (company_id, version_id, cc1_id, cc2_id, bu_id, due_date, created_by)
    VALUES (${companyId}::UUID, ${input.versionId}::UUID, ${input.cc1Id}::UUID, ${input.cc2Id}::UUID, ${input.buId}::UUID,
            ${input.dueDate}::DATE, ${actor.userId})
    ON CONFLICT ON CONSTRAINT budget_slice_reviews_one_per_slice
      DO UPDATE SET due_date = COALESCE(EXCLUDED.due_date, budget_slice_reviews.due_date)
    RETURNING id::TEXT AS id
  `) as DbRow[];
  const sliceId = String(slice[0]!.id);
  const out = await readSlice(companyId, sliceId);

  await logAuditOrThrow({
    companyId, userId: actor.userId, action: 'update', entityType: 'budget', entityId: input.versionId,
    entityRef: `Budget slice ${out.label}`,
    changes: {
      fields: [],
      metadata: {
        holderAssigned: input.userId, sliceId, slice: out.label, fiscalYear: String(version.fiscalYear),
        accounts: accounts === null ? 'all' : String(accounts.length), dueDate: out.dueDate ?? '',
      },
    },
  });
  if (input.userId !== actor.userId) {
    await notifyUsers(companyId, [input.userId], {
      kind: 'budget_slice', refId: sliceId, href: '/accounting/budgets/review',
      title: `You hold a budget slice: ${out.label}`,
      body: `${version.name} (FY${version.fiscalYear})${out.dueDate ? `, due ${out.dueDate}` : ''}`,
      dedupeKey: `budget_slice:${sliceId}:assigned:${input.userId}`,
    });
  }
  return out;
}

/** The holder is a member who is a manager, admin or owner (decision 9a). */
async function checkHolder(companyId: string, userId: string): Promise<void> {
  const rows = (await sql`
    SELECT cu.role FROM company_users cu WHERE cu.company_id = ${companyId}::UUID AND cu.user_id = ${userId}
  `) as DbRow[];
  if (!rows[0]) throw inputError('That user is not a member of this company');
  if (!HOLDER_ROLES.includes(String(rows[0].role))) {
    throw inputError(`A budget holder must be a manager, admin or owner (this member is ${String(rows[0].role)})`);
  }
}

async function checkSliceMembers(companyId: string, input: AssignHolderInput): Promise<void> {
  const centre = input.cc1Id ? { id: input.cc1Id, kind: 'cc1' } : input.cc2Id ? { id: input.cc2Id, kind: 'cc2' } : null;
  if (centre) {
    const ok = (await sql`
      SELECT 1 FROM cost_centres WHERE id = ${centre.id}::UUID AND company_id = ${companyId}::UUID AND cc_type = ${centre.kind}
    `) as DbRow[];
    if (!ok[0]) throw inputError(`${centre.kind.toUpperCase()} ${centre.id} is not a ${centre.kind.toUpperCase()} cost centre of this company`);
  }
  if (input.buId) {
    const ok = (await sql`SELECT 1 FROM business_units WHERE id = ${input.buId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
    if (!ok[0]) throw inputError(`Business unit ${input.buId} is not a business unit of this company`);
  }
}

async function checkAccounts(companyId: string, ids: string[]): Promise<void> {
  if (ids.length === 0 || ids.length > MAX_HOLDER_ACCOUNTS) throw inputError(`Name 1-${MAX_HOLDER_ACCOUNTS} accounts, or none for every account`);
  const bad = (await sql`
    SELECT t.id::TEXT AS id FROM unnest(${ids}::UUID[]) AS t(id)
     WHERE NOT EXISTS (SELECT 1 FROM gl_accounts ga WHERE ga.id = t.id AND ga.company_id = ${companyId}::UUID
                         AND ga.account_type IN ('revenue', 'expense'))
     LIMIT 1
  `) as DbRow[];
  if (bad[0]) throw inputError(`Account ${String(bad[0].id)} is not a revenue or expense account of this company`);
}
