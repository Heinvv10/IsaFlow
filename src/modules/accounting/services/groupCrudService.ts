/**
 * Group Company CRUD Service
 * Manages company groups and membership records.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

export interface CompanyGroup {
  id: string;
  name: string;
  holdingCompanyId: string | null;
  defaultCurrency: string;
  financialYearStart: number;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  memberCount?: number;
}

export interface GroupMember {
  id: string;
  groupId: string;
  companyId: string;
  companyName?: string;
  ownershipPct: number;
  consolidationMethod: string;
  isHolding: boolean;
  joinedDate: string;
  leftDate: string | null;
  createdAt: string;
}

export function mapGroup(r: Row): CompanyGroup {
  return {
    id: String(r.id),
    name: String(r.name),
    holdingCompanyId: r.holding_company_id != null ? String(r.holding_company_id) : null,
    defaultCurrency: String(r.default_currency),
    financialYearStart: Number(r.financial_year_start),
    isActive: Boolean(r.is_active),
    createdBy: r.created_by != null ? String(r.created_by) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function mapMember(r: Row): GroupMember {
  return {
    id: String(r.id),
    groupId: String(r.group_id),
    companyId: String(r.company_id),
    ownershipPct: Number(r.ownership_pct),
    consolidationMethod: String(r.consolidation_method),
    isHolding: Boolean(r.is_holding),
    joinedDate: String(r.joined_date),
    leftDate: r.left_date != null ? String(r.left_date) : null,
    createdAt: String(r.created_at),
  };
}

// ── Group CRUD ───────────────────────────────────────────────────────────────

export async function listGroups(): Promise<CompanyGroup[]> {
  const rows = (await sql`
    SELECT cg.*,
           COUNT(cgm.id) FILTER (WHERE cgm.left_date IS NULL) AS member_count
    FROM company_groups cg
    LEFT JOIN company_group_members cgm ON cgm.group_id = cg.id
    WHERE cg.is_active = true
    GROUP BY cg.id
    ORDER BY cg.name
  `) as Row[];
  return rows.map((r: Row) => ({ ...mapGroup(r), memberCount: Number(r.member_count) }));
}

export async function getGroup(groupId: string): Promise<CompanyGroup | null> {
  const rows = (await sql`
    SELECT cg.*,
           COUNT(cgm.id) FILTER (WHERE cgm.left_date IS NULL) AS member_count
    FROM company_groups cg
    LEFT JOIN company_group_members cgm ON cgm.group_id = cg.id
    WHERE cg.id = ${groupId}::UUID
    GROUP BY cg.id
  `) as Row[];
  if (!rows[0]) return null;
  return { ...mapGroup(rows[0]!), memberCount: Number(rows[0]!.member_count) };
}

export async function createGroup(input: {
  name: string;
  holdingCompanyId?: string;
  defaultCurrency?: string;
  financialYearStart?: number;
}, userId: string): Promise<CompanyGroup> {
  const rows = (await sql`
    INSERT INTO company_groups (name, holding_company_id, default_currency, financial_year_start, created_by)
    VALUES (
      ${input.name},
      ${input.holdingCompanyId || null},
      ${input.defaultCurrency || 'ZAR'},
      ${input.financialYearStart || 3},
      ${userId}::UUID
    )
    RETURNING *
  `) as Row[];

  const group = mapGroup(rows[0]!);

  if (input.holdingCompanyId) {
    await sql`
      INSERT INTO company_group_members (group_id, company_id, ownership_pct, consolidation_method, is_holding)
      VALUES (${group.id}::UUID, ${input.holdingCompanyId}::UUID, 100.00, 'full', true)
    `;
  }

  log.info('Company group created', { id: group.id, name: input.name }, 'accounting');
  return group;
}

export async function updateGroup(groupId: string, input: Partial<{
  name: string;
  holdingCompanyId: string;
  defaultCurrency: string;
  financialYearStart: number;
}>): Promise<CompanyGroup> {
  const rows = (await sql`
    UPDATE company_groups SET
      name = COALESCE(${input.name ?? null}, name),
      holding_company_id = COALESCE(${input.holdingCompanyId ?? null}, holding_company_id),
      default_currency = COALESCE(${input.defaultCurrency ?? null}, default_currency),
      financial_year_start = COALESCE(${input.financialYearStart ?? null}, financial_year_start),
      updated_at = NOW()
    WHERE id = ${groupId}::UUID
    RETURNING *
  `) as Row[];
  if (!rows[0]) throw new Error(`Company group ${groupId} not found`);
  return mapGroup(rows[0]!);
}

export async function deleteGroup(groupId: string): Promise<void> {
  await sql`
    UPDATE company_groups SET is_active = false, updated_at = NOW()
    WHERE id = ${groupId}::UUID
  `;
  log.info('Company group soft-deleted', { groupId }, 'accounting');
}

// ── Group Members ────────────────────────────────────────────────────────────

export async function addMember(groupId: string, companyId: string, opts?: {
  ownershipPct?: number;
  consolidationMethod?: string;
}): Promise<GroupMember> {
  const rows = (await sql`
    INSERT INTO company_group_members (group_id, company_id, ownership_pct, consolidation_method)
    VALUES (
      ${groupId}::UUID,
      ${companyId}::UUID,
      ${opts?.ownershipPct ?? 100},
      ${opts?.consolidationMethod ?? 'full'}
    )
    RETURNING *
  `) as Row[];
  log.info('Group member added', { groupId, companyId }, 'accounting');
  return mapMember(rows[0]!);
}

export async function updateMember(memberId: string, opts: {
  ownershipPct?: number;
  consolidationMethod?: string;
}): Promise<GroupMember> {
  const rows = (await sql`
    UPDATE company_group_members SET
      ownership_pct = COALESCE(${opts.ownershipPct ?? null}, ownership_pct),
      consolidation_method = COALESCE(${opts.consolidationMethod ?? null}, consolidation_method)
    WHERE id = ${memberId}::UUID
    RETURNING *
  `) as Row[];
  if (!rows[0]) throw new Error(`Group member ${memberId} not found`);
  return mapMember(rows[0]!);
}

export async function removeMember(memberId: string): Promise<void> {
  await sql`
    UPDATE company_group_members SET left_date = CURRENT_DATE
    WHERE id = ${memberId}::UUID
  `;
  log.info('Group member removed', { memberId }, 'accounting');
}

export async function getGroupMembers(groupId: string): Promise<GroupMember[]> {
  const rows = (await sql`
    SELECT cgm.*, c.name AS company_name
    FROM company_group_members cgm
    JOIN companies c ON c.id = cgm.company_id
    WHERE cgm.group_id = ${groupId}::UUID AND cgm.left_date IS NULL
    ORDER BY cgm.is_holding DESC, c.name ASC
  `) as Row[];
  return rows.map((r: Row) => ({ ...mapMember(r), companyName: r.company_name != null ? String(r.company_name) : undefined }));
}
