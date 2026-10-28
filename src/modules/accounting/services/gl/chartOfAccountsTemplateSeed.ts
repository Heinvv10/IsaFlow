/**
 * Seeding a company's chart from a template (POST /api/accounting/coa-seed, onboarding complete-setup).
 * Split from chartOfAccountsImportService (which holds the templates) to keep both under 300 lines.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { boundedRowWait, lockSystemRoleWrites } from './systemRoleWriteLock';
import { isSystemAccountKey, SYSTEM_ACCOUNT_KEYS } from './systemAccountKeys';
import { clearSystemAccountCacheAfterCommit } from './systemAccountResolver';
import { HOLDER_NO_CHILDREN_TYPES } from './roleTargetRules';
import { BALANCE_SHEET_LEAF_LEVEL, LEAF_RULE_ACCOUNT_TYPES } from './isReportVisibleLeaf';
import { lockGlAccountsForUpdate } from './glAccountLock';
import { getTemplateLines, type CoaTemplate, type TemplateLine } from './chartOfAccountsImportService';

/**
 * Seed a Chart of Accounts for a newly-created company from the chosen template.
 * Two-pass insert: first without parent_account_id, then wire up parents.
 */
export function seedChartOfAccountsFromTemplate(companyId: string, template: CoaTemplate): Promise<number> {
  // Bounded: every statement it runs while it holds the role lock waits at most 5s for any lock.
  return boundedRowWait(() => seedUnderLock(companyId, template));
}

/** Bounds the level pass below: a template deeper than this would be a bug in the template. */
const MAX_SEED_DEPTH = 8;

/** Returns how many accounts it inserted: codes the company already has are skipped and left as they are. */
async function seedUnderLock(companyId: string, template: CoaTemplate): Promise<number> {
  const lines = getTemplateLines(template);
  if (lines.length === 0) return 0; // 'blank' — no seeding
  // The template flags system accounts: serialise with every writer of role flags.
  await lockSystemRoleWrites(companyId);
  // A role the company already holds is not seeded again: the template's row
  // for it is SKIPPED (as a row whose code is taken is), never added as a
  // second holder for the resolver to choose between.
  const isRoleRow = (acc: TemplateLine) => acc.isSystem === true && isSystemAccountKey(acc.subtype);

  // Two statements, not two per account: the lock above is exclusive for the
  // company, so the seed holds it for as short a time as it can.
  const rows = JSON.stringify(lines.map((acc) => ({
    code: acc.code, name: acc.name, type: acc.type, subtype: acc.subtype ?? null,
    normal_balance: acc.normalBalance, level: acc.level, display_order: acc.displayOrder,
    is_system: acc.isSystem ?? false, is_role: isRoleRow(acc), parent_code: acc.parentCode ?? null,
  })));

  // Pass 1: insert all accounts (no parent yet). The codes it inserted are the only accounts pass 2 wires.
  const inserted = ((await sql`
    INSERT INTO gl_accounts (
      company_id, account_code, account_name, account_type, account_subtype,
      normal_balance, level, display_order, is_system_account
    )
    SELECT ${companyId}::UUID, t.code, t.name, t.type, t.subtype, t.normal_balance, t.level, t.display_order, t.is_system
    FROM jsonb_to_recordset(${rows}::jsonb) AS t(
      code TEXT, name TEXT, type TEXT, subtype TEXT, normal_balance TEXT,
      level INT, display_order INT, is_system BOOLEAN, is_role BOOLEAN)
    -- One late-claim clearing account per company: migration 701 may have
    -- given it one already, under another code (a second system account with
    -- the subtype would leave the resolver choosing by heap order).
    WHERE (t.subtype IS DISTINCT FROM 'vat_input_late_claim'
       OR NOT EXISTS (SELECT 1 FROM gl_accounts WHERE company_id = ${companyId}::UUID
                        AND account_subtype = 'vat_input_late_claim'))
      AND (NOT t.is_role
       OR NOT EXISTS (SELECT 1 FROM gl_accounts WHERE company_id = ${companyId}::UUID
                        AND account_subtype = t.subtype AND is_system_account AND is_active))
    ON CONFLICT (company_id, account_code) DO NOTHING
    RETURNING account_code
  `) as { account_code: string }[]).map((r) => r.account_code);
  if (inserted.length === 0) { clearSystemAccountCacheAfterCommit(companyId); return 0; }

  // A template parent the company already had, at level 1-2 of a balance-sheet type, would lose its own
  // balance from the balance sheet on its first child (the rule assertParentUsable applies to every other
  // chart write). Locked FOR UPDATE before pass 2 reads it, so a journal posting its first line waits.
  const parentCodes = [...new Set(lines.filter((l) => l.parentCode && inserted.includes(l.code)).map((l) => l.parentCode!))];
  const atRisk = (await sql`
    SELECT id FROM gl_accounts
     WHERE company_id = ${companyId}::UUID AND account_code = ANY(${parentCodes}::TEXT[])
       AND account_type = ANY(${[...LEAF_RULE_ACCOUNT_TYPES]}::TEXT[]) AND level < ${BALANCE_SHEET_LEAF_LEVEL}
  `) as { id: string }[];
  if (atRisk.length > 0) await lockGlAccountsForUpdate(companyId, atRisk.map((r) => String(r.id)));

  // Pass 2: wire up parent_account_id of the accounts pass 1 inserted (an existing account keeps the
  // parent the company gave it). NULL when the parent's code is absent — or is held by a balance-sheet
  // account with a system role: the company's own bank on the template's "Current Assets" code must not
  // become a header with sub-accounts (an income-statement holder may: `roleBarringChildren`) — or is a
  // level 1-2 balance-sheet account with lines and no children yet, which the child would hide.
  await sql`
    UPDATE gl_accounts c
    SET parent_account_id = (
      SELECT p.id FROM gl_accounts p
      WHERE p.company_id = ${companyId}::UUID AND p.account_code = t.parent_code
        -- Same type as the child, as assertParentUsable requires of every other write.
        AND p.account_type = c.account_type
        -- COALESCE: with a NULL subtype the AND is NULL, NOT NULL is NULL, and
        -- every sub-account of an unclassified system header lost its parent.
        AND NOT COALESCE(p.is_system_account AND p.account_subtype = ANY(${[...SYSTEM_ACCOUNT_KEYS]}::TEXT[])
                         AND p.account_type = ANY(${[...HOLDER_NO_CHILDREN_TYPES]}::TEXT[]), false)
        AND NOT (p.account_type = ANY(${[...LEAF_RULE_ACCOUNT_TYPES]}::TEXT[]) AND p.level < ${BALANCE_SHEET_LEAF_LEVEL}
          AND NOT EXISTS (SELECT 1 FROM gl_accounts ch WHERE ch.parent_account_id = p.id AND ch.company_id = ${companyId}::UUID)
          AND EXISTS (SELECT 1 FROM gl_journal_lines jl WHERE jl.gl_account_id = p.id AND jl.company_id = ${companyId}::UUID))
    )
    FROM jsonb_to_recordset(${rows}::jsonb) AS t(code TEXT, parent_code TEXT)
    WHERE c.company_id = ${companyId}::UUID AND c.account_code = t.code AND t.parent_code IS NOT NULL
      AND c.account_code = ANY(${inserted}::TEXT[])
  `;

  // Levels follow the parents actually given (the template's level assumed the template's parent): one below
  // the parent, as the import and the bank grouping set them, and 1 for an account left without one. Top-down,
  // one tree level per pass; the template is a few levels deep, MAX_SEED_DEPTH bounds a bad one.
  await sql`
    UPDATE gl_accounts SET level = 1
     WHERE company_id = ${companyId}::UUID AND account_code = ANY(${inserted}::TEXT[])
       AND parent_account_id IS NULL AND level IS DISTINCT FROM 1
  `;
  for (let depth = 0; depth < MAX_SEED_DEPTH; depth += 1) {
    const moved = (await sql`
      UPDATE gl_accounts c SET level = p.level + 1
        FROM gl_accounts p
       WHERE c.company_id = ${companyId}::UUID AND p.company_id = ${companyId}::UUID
         AND c.parent_account_id = p.id AND c.account_code = ANY(${inserted}::TEXT[])
         AND c.level IS DISTINCT FROM p.level + 1
      RETURNING c.id
    `) as unknown[];
    if (moved.length === 0) break;
  }

  clearSystemAccountCacheAfterCommit(companyId);
  log.info('COA seeded from template', { companyId, template, inserted: inserted.length }, 'accounting');
  return inserted.length;
}

