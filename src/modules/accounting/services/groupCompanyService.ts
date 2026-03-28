/**
 * Group Company Service
 * Manages company groups, memberships, group COA, COA mappings,
 * and intercompany transactions for consolidated reporting.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

// ── Types ────────────────────────────────────────────────────────────────────

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

export interface IntercompanyTransaction {
  id: string;
  groupId: string;
  sourceCompanyId: string;
  sourceCompanyName?: string;
  targetCompanyId: string;
  targetCompanyName?: string;
  sourceJournalEntryId: string | null;
  targetJournalEntryId: string | null;
  transactionType: string;
  amount: number;
  currency: string;
  description: string | null;
  transactionDate: string;
  matchStatus: string;
  varianceAmount: number;
  matchedAt: string | null;
  matchedBy: string | null;
  createdAt: string;
}

export interface IntercompanyReconciliation {
  totalTransactions: number;
  matched: number;
  unmatched: number;
  partial: number;
  variance: number;
  totalAmount: number;
  matchedAmount: number;
  unmatchedAmount: number;
  varianceTotal: number;
  transactions: IntercompanyTransaction[];
}

export interface IntercompanyFilters {
  dateFrom?: string;
  dateTo?: string;
  matchStatus?: string;
  sourceCompanyId?: string;
  targetCompanyId?: string;
  transactionType?: string;
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
  return { ...mapGroup(rows[0]), memberCount: Number(rows[0].member_count) };
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

  const group = mapGroup(rows[0]);

  // Auto-add holding company as member if specified
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
  return mapGroup(rows[0]);
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
  return mapMember(rows[0]);
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
  return mapMember(rows[0]);
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
  return rows.map((r: Row) => ({ ...mapMember(r), companyName: r.company_name }));
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
  return mapGroupAccount(rows[0]);
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
  return mapGroupAccount(rows[0]);
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
  return mapCoaMapping(rows[0]);
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
    id: r.id,
    accountCode: r.account_code,
    accountName: r.account_name,
    accountType: r.account_type,
  }));
}

// ── Intercompany Transactions ────────────────────────────────────────────────

export async function listIntercompanyTransactions(
  groupId: string,
  filters?: IntercompanyFilters,
): Promise<IntercompanyTransaction[]> {
  const rows = (await sql`
    SELECT it.*,
           sc.name AS source_company_name,
           tc.name AS target_company_name
    FROM intercompany_transactions it
    JOIN companies sc ON sc.id = it.source_company_id
    JOIN companies tc ON tc.id = it.target_company_id
    WHERE it.group_id = ${groupId}::UUID
      AND (${filters?.dateFrom || null}::DATE IS NULL OR it.transaction_date >= ${filters?.dateFrom || null}::DATE)
      AND (${filters?.dateTo || null}::DATE IS NULL OR it.transaction_date <= ${filters?.dateTo || null}::DATE)
      AND (${filters?.matchStatus || null}::TEXT IS NULL OR it.match_status = ${filters?.matchStatus || null})
      AND (${filters?.sourceCompanyId || null}::UUID IS NULL OR it.source_company_id = ${filters?.sourceCompanyId || null}::UUID)
      AND (${filters?.targetCompanyId || null}::UUID IS NULL OR it.target_company_id = ${filters?.targetCompanyId || null}::UUID)
      AND (${filters?.transactionType || null}::TEXT IS NULL OR it.transaction_type = ${filters?.transactionType || null})
    ORDER BY it.transaction_date DESC, it.created_at DESC
  `) as Row[];
  return rows.map(mapIntercompanyTx);
}

export async function createIntercompanyTransaction(input: {
  groupId: string;
  sourceCompanyId: string;
  targetCompanyId: string;
  sourceJournalEntryId?: string;
  targetJournalEntryId?: string;
  transactionType: string;
  amount: number;
  currency?: string;
  description?: string;
  transactionDate: string;
}): Promise<IntercompanyTransaction> {
  const rows = (await sql`
    INSERT INTO intercompany_transactions (
      group_id, source_company_id, target_company_id,
      source_journal_entry_id, target_journal_entry_id,
      transaction_type, amount, currency, description, transaction_date
    )
    VALUES (
      ${input.groupId}::UUID,
      ${input.sourceCompanyId}::UUID,
      ${input.targetCompanyId}::UUID,
      ${input.sourceJournalEntryId || null},
      ${input.targetJournalEntryId || null},
      ${input.transactionType},
      ${input.amount},
      ${input.currency || 'ZAR'},
      ${input.description || null},
      ${input.transactionDate}::DATE
    )
    RETURNING *
  `) as Row[];
  log.info('Intercompany transaction created', {
    id: rows[0].id,
    groupId: input.groupId,
    type: input.transactionType,
    amount: input.amount,
  }, 'accounting');
  return mapIntercompanyTx(rows[0]);
}

export async function matchIntercompanyTransactions(
  sourceId: string,
  targetId: string,
): Promise<void> {
  // Fetch both sides
  const sources = (await sql`SELECT * FROM intercompany_transactions WHERE id = ${sourceId}::UUID`) as Row[];
  const targets = (await sql`SELECT * FROM intercompany_transactions WHERE id = ${targetId}::UUID`) as Row[];

  if (!sources[0] || !targets[0]) {
    throw new Error('One or both intercompany transactions not found');
  }

  const source = sources[0];
  const target = targets[0];
  const variance = Math.abs(Number(source.amount) - Number(target.amount));
  const status = variance === 0 ? 'matched' : 'variance';

  await sql`
    UPDATE intercompany_transactions SET
      match_status = ${status},
      variance_amount = ${variance},
      matched_at = NOW()
    WHERE id IN (${sourceId}::UUID, ${targetId}::UUID)
  `;

  log.info('Intercompany transactions matched', { sourceId, targetId, status, variance }, 'accounting');
}

export async function getIntercompanyReconciliation(
  groupId: string,
  periodStart: string,
  periodEnd: string,
): Promise<IntercompanyReconciliation> {
  const rows = (await sql`
    SELECT it.*,
           sc.name AS source_company_name,
           tc.name AS target_company_name
    FROM intercompany_transactions it
    JOIN companies sc ON sc.id = it.source_company_id
    JOIN companies tc ON tc.id = it.target_company_id
    WHERE it.group_id = ${groupId}::UUID
      AND it.transaction_date >= ${periodStart}::DATE
      AND it.transaction_date <= ${periodEnd}::DATE
    ORDER BY it.transaction_date DESC
  `) as Row[];

  const transactions = rows.map(mapIntercompanyTx);
  const matched = transactions.filter(t => t.matchStatus === 'matched');
  const unmatched = transactions.filter(t => t.matchStatus === 'unmatched');
  const partial = transactions.filter(t => t.matchStatus === 'partial');
  const withVariance = transactions.filter(t => t.matchStatus === 'variance');

  return {
    totalTransactions: transactions.length,
    matched: matched.length,
    unmatched: unmatched.length,
    partial: partial.length,
    variance: withVariance.length,
    totalAmount: transactions.reduce((sum, t) => sum + t.amount, 0),
    matchedAmount: matched.reduce((sum, t) => sum + t.amount, 0),
    unmatchedAmount: unmatched.reduce((sum, t) => sum + t.amount, 0),
    varianceTotal: withVariance.reduce((sum, t) => sum + t.varianceAmount, 0),
    transactions,
  };
}

// ── Mappers ──────────────────────────────────────────────────────────────────

function mapGroup(r: Row): CompanyGroup {
  return {
    id: r.id,
    name: r.name,
    holdingCompanyId: r.holding_company_id,
    defaultCurrency: r.default_currency,
    financialYearStart: r.financial_year_start,
    isActive: r.is_active,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapMember(r: Row): GroupMember {
  return {
    id: r.id,
    groupId: r.group_id,
    companyId: r.company_id,
    ownershipPct: Number(r.ownership_pct),
    consolidationMethod: r.consolidation_method,
    isHolding: r.is_holding,
    joinedDate: r.joined_date,
    leftDate: r.left_date,
    createdAt: r.created_at,
  };
}

function mapGroupAccount(r: Row): GroupAccount {
  return {
    id: r.id,
    groupId: r.group_id,
    accountCode: r.account_code,
    accountName: r.account_name,
    accountType: r.account_type,
    accountSubtype: r.account_subtype,
    parentAccountId: r.parent_account_id,
    normalBalance: r.normal_balance,
    level: r.level,
    displayOrder: r.display_order,
    isActive: r.is_active,
    createdAt: r.created_at,
  };
}

function mapCoaMapping(r: Row): CoaMapping {
  return {
    id: r.id,
    groupId: r.group_id,
    groupAccountId: r.group_account_id,
    groupAccountCode: r.group_account_code,
    groupAccountName: r.group_account_name,
    companyId: r.company_id,
    companyAccountId: r.company_account_id,
    companyAccountCode: r.company_account_code,
    companyAccountName: r.company_account_name,
    createdAt: r.created_at,
  };
}

function mapIntercompanyTx(r: Row): IntercompanyTransaction {
  return {
    id: r.id,
    groupId: r.group_id,
    sourceCompanyId: r.source_company_id,
    sourceCompanyName: r.source_company_name,
    targetCompanyId: r.target_company_id,
    targetCompanyName: r.target_company_name,
    sourceJournalEntryId: r.source_journal_entry_id,
    targetJournalEntryId: r.target_journal_entry_id,
    transactionType: r.transaction_type,
    amount: Number(r.amount),
    currency: r.currency,
    description: r.description,
    transactionDate: r.transaction_date,
    matchStatus: r.match_status,
    varianceAmount: Number(r.variance_amount),
    matchedAt: r.matched_at,
    matchedBy: r.matched_by,
    createdAt: r.created_at,
  };
}
