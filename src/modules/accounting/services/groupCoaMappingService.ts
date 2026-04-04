/**
 * Group Chart of Accounts & COA Mapping Service
 * Manages group-level accounts and company-to-group account mappings.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

export interface GroupAccount {
  id: string;
  groupId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
  parentAccountId: string | null;
  normalBalance: string;
  level: number;
  displayOrder: number;
  isActive: boolean;
  createdAt: string;
}

export interface CoaMapping {
  id: string;
  groupId: string;
  groupAccountId: string;
  groupAccountCode?: string;
  groupAccountName?: string;
  companyId: string;
  companyAccountId: string;
  companyAccountCode?: string;
  companyAccountName?: string;
  createdAt: string;
}

export function mapGroupAccount(r: Row): GroupAccount {
  return {
    id: String(r.id),
    groupId: String(r.group_id),
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
    accountType: String(r.account_type),
    accountSubtype: r.account_subtype != null ? String(r.account_subtype) : null,
    parentAccountId: r.parent_account_id != null ? String(r.parent_account_id) : null,
    normalBalance: String(r.normal_balance),
    level: Number(r.level),
    displayOrder: Number(r.display_order),
    isActive: Boolean(r.is_active),
    createdAt: String(r.created_at),
  };
}

export function mapCoaMapping(r: Row): CoaMapping {
  return {
    id: String(r.id),
    groupId: String(r.group_id),
    groupAccountId: String(r.group_account_id),
    groupAccountCode: r.group_account_code != null ? String(r.group_account_code) : undefined,
    groupAccountName: r.group_account_name != null ? String(r.group_account_name) : undefined,
    companyId: String(r.company_id),
    companyAccountId: String(r.company_account_id),
    companyAccountCode: r.company_account_code != null ? String(r.company_account_code) : undefined,
    companyAccountName: r.company_account_name != null ? String(r.company_account_name) : undefined,
    createdAt: String(r.created_at),
  };
}

// ── Group Chart of Accounts ──────────────────────────────────────────────────

export async function getGroupAccounts(groupId: string): Promise<GroupAccount[]> {
  const rows = (await sql`
    SELECT * FROM group_accounts
    WHERE group_id = ${groupId}::UUID AND is_active = true
    ORDER BY display_order, account_code
  `) as Row[];
  return rows.map(mapGroupAccount);
}

export async function createGroupAccount(groupId: string, input: {
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype?: string;
  parentAccountId?: string;
  normalBalance?: string;
  level?: number;
  displayOrder?: number;
}): Promise<GroupAccount> {
  const rows = (await sql`
    INSERT INTO group_accounts (
      group_id, account_code, account_name, account_type, account_subtype,
      parent_account_id, normal_balance, level, display_order
    )
    VALUES (
      ${groupId}::UUID,
      ${input.accountCode},
      ${input.accountName},
      ${input.accountType},
      ${input.accountSubtype || null},
      ${input.parentAccountId || null},
      ${input.normalBalance || 'debit'},
      ${input.level ?? 1},
      ${input.displayOrder ?? 0}
    )
    RETURNING *
  `) as Row[];
  log.info('Group account created', { groupId, code: input.accountCode }, 'accounting');
  return mapGroupAccount(rows[0]!);
}

export async function updateGroupAccount(accountId: string, input: Partial<{
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string;
  parentAccountId: string;
  normalBalance: string;
  level: number;
  displayOrder: number;
}>): Promise<GroupAccount> {
  const rows = (await sql`
    UPDATE group_accounts SET
      account_code = COALESCE(${input.accountCode ?? null}, account_code),
      account_name = COALESCE(${input.accountName ?? null}, account_name),
      account_type = COALESCE(${input.accountType ?? null}, account_type),
      account_subtype = COALESCE(${input.accountSubtype ?? null}, account_subtype),
      parent_account_id = COALESCE(${input.parentAccountId ?? null}, parent_account_id),
      normal_balance = COALESCE(${input.normalBalance ?? null}, normal_balance),
      level = COALESCE(${input.level ?? null}, level),
      display_order = COALESCE(${input.displayOrder ?? null}, display_order)
    WHERE id = ${accountId}::UUID
    RETURNING *
  `) as Row[];
  if (!rows[0]) throw new Error(`Group account ${accountId} not found`);
  return mapGroupAccount(rows[0]!);
}

export async function deleteGroupAccount(accountId: string): Promise<void> {
  await sql`
    UPDATE group_accounts SET is_active = false
    WHERE id = ${accountId}::UUID
  `;
}

export async function autoGenerateGroupCOA(groupId: string, sourceCompanyId: string): Promise<number> {
  const rows = (await sql`
    INSERT INTO group_accounts (group_id, account_code, account_name, account_type, account_subtype, normal_balance, level, display_order)
    SELECT
      ${groupId}::UUID,
      a.account_code,
      a.account_name,
      a.account_type,
      a.account_subtype,
      a.normal_balance,
      COALESCE(a.level, 1),
      COALESCE(a.display_order, 0)
    FROM gl_accounts a
    WHERE a.company_id = ${sourceCompanyId}::UUID AND a.is_active = true
    ON CONFLICT (group_id, account_code) DO NOTHING
    RETURNING id
  `) as Row[];
  log.info('Group COA auto-generated', { groupId, sourceCompanyId, count: rows.length }, 'accounting');
  return rows.length;
}

// ── COA Mappings ─────────────────────────────────────────────────────────────

export async function getCoaMappings(groupId: string, companyId?: string): Promise<CoaMapping[]> {
  const rows = companyId
    ? (await sql`
        SELECT m.*,
               ga.account_code AS group_account_code, ga.account_name AS group_account_name,
               ca.account_code AS company_account_code, ca.account_name AS company_account_name
        FROM group_coa_mappings m
        JOIN group_accounts ga ON ga.id = m.group_account_id
        JOIN gl_accounts ca ON ca.id = m.company_account_id
        WHERE m.group_id = ${groupId}::UUID AND m.company_id = ${companyId}::UUID
        ORDER BY ga.account_code
      `) as Row[]
    : (await sql`
        SELECT m.*,
               ga.account_code AS group_account_code, ga.account_name AS group_account_name,
               ca.account_code AS company_account_code, ca.account_name AS company_account_name
        FROM group_coa_mappings m
        JOIN group_accounts ga ON ga.id = m.group_account_id
        JOIN gl_accounts ca ON ca.id = m.company_account_id
        WHERE m.group_id = ${groupId}::UUID
        ORDER BY m.company_id, ga.account_code
      `) as Row[];
  return rows.map(mapCoaMapping);
}

export async function setCoaMapping(
  groupId: string,
  companyId: string,
  companyAccountId: string,
  groupAccountId: string,
): Promise<CoaMapping> {
  const rows = (await sql`
    INSERT INTO group_coa_mappings (group_id, company_id, company_account_id, group_account_id)
    VALUES (${groupId}::UUID, ${companyId}::UUID, ${companyAccountId}::UUID, ${groupAccountId}::UUID)
    ON CONFLICT (group_id, company_id, company_account_id)
    DO UPDATE SET group_account_id = ${groupAccountId}::UUID
    RETURNING *
  `) as Row[];
  return mapCoaMapping(rows[0]!);
}

export async function removeCoaMapping(mappingId: string): Promise<void> {
  await sql`DELETE FROM group_coa_mappings WHERE id = ${mappingId}::UUID`;
}

export async function autoMapAccounts(groupId: string, companyId: string): Promise<number> {
  const rows = (await sql`
    INSERT INTO group_coa_mappings (group_id, company_id, company_account_id, group_account_id)
    SELECT
      ${groupId}::UUID,
      ${companyId}::UUID,
      ca.id,
      ga.id
    FROM gl_accounts ca
    JOIN group_accounts ga ON ga.group_id = ${groupId}::UUID AND ga.account_code = ca.account_code AND ga.is_active = true
    WHERE ca.company_id = ${companyId}::UUID AND ca.is_active = true
    ON CONFLICT (group_id, company_id, company_account_id) DO NOTHING
    RETURNING id
  `) as Row[];
  log.info('Auto-mapped accounts', { groupId, companyId, mapped: rows.length }, 'accounting');
  return rows.length;
}

export async function getUnmappedAccounts(groupId: string, companyId: string): Promise<{
  id: string;
  accountCode: string;
  accountName: string;
  accountType: string;
}[]> {
  const rows = (await sql`
    SELECT ca.id, ca.account_code, ca.account_name, ca.account_type
    FROM gl_accounts ca
    WHERE ca.company_id = ${companyId}::UUID
      AND ca.is_active = true
      AND NOT EXISTS (
        SELECT 1 FROM group_coa_mappings m
        WHERE m.group_id = ${groupId}::UUID
          AND m.company_id = ${companyId}::UUID
          AND m.company_account_id = ca.id
      )
    ORDER BY ca.account_code
  `) as Row[];
  return rows.map((r: Row) => ({
    id: String(r.id),
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
    accountType: String(r.account_type),
  }));
}
