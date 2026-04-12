/**
 * Account Reporting Groups Service
 * Manages custom GL account groupings for financial report subtotals (Sage parity)
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/lib/neon';

export interface AccountReportingGroup {
  id: string;
  company_id: string;
  name: string;
  report_type: 'balance_sheet' | 'income_statement' | 'both';
  display_order: number;
  is_active: boolean;
  created_at: string;
  member_count: number;
  members: GroupMember[];
}

export interface GroupMember {
  gl_account_id: string;
  account_code: string;
  account_name: string;
}

export interface CreateGroupInput {
  name: string;
  report_type: 'balance_sheet' | 'income_statement' | 'both';
  display_order?: number;
}

export interface UpdateGroupInput {
  name?: string;
  report_type?: 'balance_sheet' | 'income_statement' | 'both';
  display_order?: number;
}

export async function listAccountReportingGroups(
  companyId: string
): Promise<AccountReportingGroup[]> {
  const rows = await sql`
    SELECT
      g.id,
      g.company_id,
      g.name,
      g.report_type,
      g.display_order,
      g.is_active,
      g.created_at,
      COUNT(m.gl_account_id)::int AS member_count,
      COALESCE(
        json_agg(
          json_build_object(
            'gl_account_id', a.id,
            'account_code', a.code,
            'account_name', a.name
          ) ORDER BY a.code
        ) FILTER (WHERE a.id IS NOT NULL),
        '[]'
      ) AS members
    FROM account_reporting_groups g
    LEFT JOIN account_reporting_group_members m ON m.group_id = g.id
    LEFT JOIN gl_accounts a ON a.id = m.gl_account_id
    WHERE g.company_id = ${companyId}
      AND g.is_active = true
    GROUP BY g.id
    ORDER BY g.display_order, g.name
  ` as DbRow[];

  return rows.map(rowToGroup);
}

export async function getAccountReportingGroup(
  companyId: string,
  groupId: string
): Promise<AccountReportingGroup | null> {
  const rows = await sql`
    SELECT
      g.id,
      g.company_id,
      g.name,
      g.report_type,
      g.display_order,
      g.is_active,
      g.created_at,
      COUNT(m.gl_account_id)::int AS member_count,
      COALESCE(
        json_agg(
          json_build_object(
            'gl_account_id', a.id,
            'account_code', a.code,
            'account_name', a.name
          ) ORDER BY a.code
        ) FILTER (WHERE a.id IS NOT NULL),
        '[]'
      ) AS members
    FROM account_reporting_groups g
    LEFT JOIN account_reporting_group_members m ON m.group_id = g.id
    LEFT JOIN gl_accounts a ON a.id = m.gl_account_id
    WHERE g.id = ${groupId}
      AND g.company_id = ${companyId}
    GROUP BY g.id
  ` as DbRow[];

  if (!rows.length || !rows[0]) return null;
  return rowToGroup(rows[0]);
}

export async function createAccountReportingGroup(
  companyId: string,
  input: CreateGroupInput
): Promise<AccountReportingGroup> {
  const rows = await sql`
    INSERT INTO account_reporting_groups (company_id, name, report_type, display_order)
    VALUES (${companyId}, ${input.name}, ${input.report_type}, ${input.display_order ?? 0})
    RETURNING id, company_id, name, report_type, display_order, is_active, created_at
  ` as DbRow[];

  if (!rows.length || !rows[0]) {
    throw new Error('Failed to create account reporting group');
  }

  log.info('Created account reporting group', { companyId, name: input.name }, 'accounting-service');

  return {
    ...rowToGroup(rows[0]),
    member_count: 0,
    members: [],
  };
}

export async function updateAccountReportingGroup(
  companyId: string,
  groupId: string,
  input: UpdateGroupInput
): Promise<AccountReportingGroup | null> {
  // Build partial update — only set provided fields
  const existing = await getAccountReportingGroup(companyId, groupId);
  if (!existing) return null;

  const rows = await sql`
    UPDATE account_reporting_groups
    SET
      name = ${input.name ?? existing.name},
      report_type = ${input.report_type ?? existing.report_type},
      display_order = ${input.display_order ?? existing.display_order}
    WHERE id = ${groupId}
      AND company_id = ${companyId}
    RETURNING id
  ` as DbRow[];

  if (!rows.length) return null;

  log.info('Updated account reporting group', { companyId, groupId }, 'accounting-service');
  return getAccountReportingGroup(companyId, groupId);
}

export async function softDeleteAccountReportingGroup(
  companyId: string,
  groupId: string
): Promise<boolean> {
  const rows = await sql`
    UPDATE account_reporting_groups
    SET is_active = false
    WHERE id = ${groupId}
      AND company_id = ${companyId}
    RETURNING id
  ` as DbRow[];

  if (rows.length) {
    log.info('Soft-deleted account reporting group', { companyId, groupId }, 'accounting-service');
  }
  return rows.length > 0;
}

export async function replaceGroupMembers(
  companyId: string,
  groupId: string,
  glAccountIds: string[]
): Promise<GroupMember[]> {
  // Verify group belongs to company
  const groupRows = await sql`
    SELECT id FROM account_reporting_groups
    WHERE id = ${groupId} AND company_id = ${companyId} AND is_active = true
  ` as DbRow[];

  if (!groupRows.length) {
    throw new Error('Group not found or access denied');
  }

  // Verify all gl_account_ids belong to this company
  if (glAccountIds.length > 0) {
    const accountRows = await sql`
      SELECT id FROM gl_accounts
      WHERE id = ANY(${glAccountIds}::uuid[])
        AND company_id = ${companyId}
    ` as DbRow[];

    if (accountRows.length !== glAccountIds.length) {
      throw new Error('One or more GL accounts not found or access denied');
    }
  }

  // Replace all members in a transaction
  await sql`DELETE FROM account_reporting_group_members WHERE group_id = ${groupId}`;

  if (glAccountIds.length > 0) {
    await sql`
      INSERT INTO account_reporting_group_members (group_id, gl_account_id)
      SELECT ${groupId}::uuid, unnest(${glAccountIds}::uuid[])
    `;
  }

  log.info('Replaced group members', { companyId, groupId, count: glAccountIds.length }, 'accounting-service');

  // Return updated members
  const group = await getAccountReportingGroup(companyId, groupId);
  return group?.members ?? [];
}

// ---- helpers ----------------------------------------------------------------

function rowToGroup(row: DbRow): AccountReportingGroup {
  const members = typeof row.members === 'string'
    ? (JSON.parse(row.members) as GroupMember[])
    : (row.members as GroupMember[]) ?? [];

  const createdAt = row.created_at instanceof Date
    ? row.created_at.toISOString()
    : String(row.created_at ?? '');

  return {
    id: String(row.id),
    company_id: String(row.company_id),
    name: String(row.name),
    report_type: row.report_type as AccountReportingGroup['report_type'],
    display_order: Number(row.display_order ?? 0),
    is_active: Boolean(row.is_active),
    created_at: createdAt,
    member_count: Number(row.member_count ?? 0),
    members,
  };
}
