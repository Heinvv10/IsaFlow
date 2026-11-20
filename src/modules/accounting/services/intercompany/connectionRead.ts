/**
 * Reads for the intercompany connections page: this company's connections (each with its OWN side only: a
 * company never reads its partner's) and the group companies a group connection could be made with.
 * Everything runs on the request's transaction, so RLS (1000, 1002) already limits rows to this company's.
 */
import { sql } from '@/lib/neon';
import { DEFAULT_WRITE_ROLES } from '@/lib/auth/writeRoles';
import { toIsoTimestamp } from '@/lib/dateUtils';
import { computeChecklist } from './connectionValidation';
import type {
  ConnectionKind, ConnectionStatus, ConnectionView, GroupCandidate, NamedRef, OwnSide, PairSettings, SettlementMode,
} from './connectionTypes';

type Row = Record<string, unknown>;

const text = (v: unknown): string | null => (v == null ? null : String(v));
const ref = (id: unknown, label: string | null): NamedRef | null => (id == null ? null : { id: String(id), label: label ?? '' });
const account = (id: unknown, code: unknown, name: unknown): NamedRef | null =>
  ref(id, code == null ? null : `${String(code)} ${String(name ?? '')}`.trim());

function toSide(r: Row): OwnSide | null {
  if (r.side_id == null) return null;
  return {
    customerId: text(r.customer_id),
    supplierId: text(r.supplier_id),
    loanAccountId: text(r.loan_account_id),
    defaultExpenseAccountId: text(r.default_expense_account_id),
    autoAccept: r.auto_accept === true,
    customer: ref(r.customer_id, text(r.customer_name)),
    supplier: ref(r.supplier_id, text(r.supplier_name)),
    loanAccount: account(r.loan_account_id, r.loan_code, r.loan_name),
    defaultExpenseAccount: account(r.default_expense_account_id, r.exp_code, r.exp_name),
  };
}

function toView(r: Row): ConnectionView {
  const side = toSide(r);
  const settings: PairSettings = {
    settlementMode: String(r.settlement_mode) as SettlementMode,
    cutoverDate: text(r.cutover_date),
    interestRatePct: r.interest_rate_pct == null ? null : Number(r.interest_rate_pct),
  };
  return {
    id: String(r.id),
    kind: String(r.kind) as ConnectionKind,
    status: String(r.status) as ConnectionStatus,
    partnerCompanyId: String(r.partner_company_id),
    partnerName: text(r.partner_name) ?? 'Another company',
    invitedByCompanyId: String(r.invited_by_company_id),
    createdAt: toIsoTimestamp(r.created_at as Date | string) ?? '',
    revokedAt: toIsoTimestamp(r.revoked_at as Date | string | null),
    settings,
    canEditSettings: r.can_edit_settings === true,
    side,
    checklist: computeChecklist(side, settings),
  };
}

/** This company's connections, live ones first; `connectionId` narrows it to one. */
export async function listConnections(companyId: string, connectionId?: string): Promise<ConnectionView[]> {
  const rows = (await sql`
    SELECT c.id, c.kind, c.status, c.invited_by_company_id, c.created_at, c.revoked_at,
           c.settlement_mode, to_char(c.cutover_date, 'YYYY-MM-DD') AS cutover_date, c.interest_rate_pct::float8 AS interest_rate_pct,
           public.intercompany_user_can_write(c.company_low_id) AND public.intercompany_user_can_write(c.company_high_id) AS can_edit_settings,
           p.partner_company_id, pc.name AS partner_name,
           s.id AS side_id, s.customer_id, s.supplier_id, s.loan_account_id,
           s.default_expense_account_id, s.auto_accept,
           cu.name AS customer_name, su.name AS supplier_name,
           la.account_code AS loan_code, la.account_name AS loan_name,
           ea.account_code AS exp_code, ea.account_name AS exp_name
    FROM intercompany_connections c
    CROSS JOIN LATERAL (
      SELECT CASE WHEN c.company_low_id = ${companyId}::UUID THEN c.company_high_id ELSE c.company_low_id END AS partner_company_id
    ) p
    LEFT JOIN companies pc ON pc.id = p.partner_company_id
    LEFT JOIN intercompany_connection_sides s ON s.connection_id = c.id AND s.company_id = ${companyId}::UUID
    LEFT JOIN customers cu ON cu.id = s.customer_id AND cu.company_id = ${companyId}::UUID
    LEFT JOIN suppliers su ON su.id = s.supplier_id AND su.company_id = ${companyId}::UUID
    LEFT JOIN gl_accounts la ON la.id = s.loan_account_id AND la.company_id = ${companyId}::UUID
    LEFT JOIN gl_accounts ea ON ea.id = s.default_expense_account_id AND ea.company_id = ${companyId}::UUID
    WHERE (c.company_low_id = ${companyId}::UUID OR c.company_high_id = ${companyId}::UUID)
      AND (${connectionId ?? null}::UUID IS NULL OR c.id = ${connectionId ?? null}::UUID)
    ORDER BY (c.status = 'revoked'), c.created_at DESC, c.id
  `) as Row[];
  return rows.map(toView);
}

/**
 * Companies this one could open a GROUP connection with: current members of a group it is itself a current
 * member of, where the user holds a write role (owner / admin / manager) in the other company too.
 */
export async function listGroupCandidates(userId: string, companyId: string): Promise<GroupCandidate[]> {
  const rows = (await sql`
    SELECT DISTINCT ON (other.company_id)
           other.company_id, co.name AS company_name, g.name AS group_name, ic.status AS connection_status
    FROM company_group_members me
    JOIN company_group_members other
      ON other.group_id = me.group_id AND other.company_id <> me.company_id AND other.left_date IS NULL
    JOIN company_groups g ON g.id = me.group_id
    JOIN companies co ON co.id = other.company_id
    LEFT JOIN intercompany_connections ic
      ON ic.company_low_id = (CASE WHEN me.company_id::TEXT < other.company_id::TEXT THEN me.company_id ELSE other.company_id END)
     AND ic.company_high_id = (CASE WHEN me.company_id::TEXT < other.company_id::TEXT THEN other.company_id ELSE me.company_id END)
    WHERE me.company_id = ${companyId}::UUID AND me.left_date IS NULL
      AND EXISTS (
        SELECT 1 FROM company_users cu
        WHERE cu.company_id = other.company_id AND cu.user_id = ${userId}
          AND cu.role = ANY(${[...DEFAULT_WRITE_ROLES]}::TEXT[])
      )
    ORDER BY other.company_id, (CASE WHEN ic.status IS NULL THEN 2 WHEN ic.status = 'revoked' THEN 1 ELSE 0 END), g.name
  `) as Row[];
  return rows
    .map((r) => ({
      companyId: String(r.company_id),
      companyName: String(r.company_name),
      groupName: String(r.group_name),
      connectionStatus: r.connection_status == null ? null : (String(r.connection_status) as ConnectionStatus),
    }))
    .sort((a, b) => a.companyName.localeCompare(b.companyName));
}
