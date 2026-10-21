/**
 * Company category mappings — which of the company's OWN GL accounts each ISAFlow merchant category means
 * (Hein, 2026-10-21, decision 1). Table company_category_mappings (migration 905).
 *
 * Callers: pages/api/accounting/category-mappings.ts under withAuth (app_user, RLS-bound to the active
 * company). Every statement still names company_id; the composite FK refuses another tenant's account.
 *
 * Auto-map: the template a company was seeded from is stored nowhere, and the same account code means
 * different accounts in different companies (merchantCategories.ts), so auto-map matches account NAMES:
 * an active, posting-level account whose normalised name equals one of the category's aliases, and is the
 * only such account, is proposed. It only fills categories nobody has mapped; it never overwrites a
 * person's mapping. Every auto row is labelled and editable on the mapping page.
 */

import { sql } from '@/lib/neon';
import {
  MERCHANT_CATEGORIES, MERCHANT_CATEGORY_LIST_VERSION, merchantCategory, normaliseAccountName,
} from './merchantCategories';

export interface MappingAccount { id: string; accountCode: string | null; accountName: string }

export interface CategoryMappingView {
  code: string;
  label: string;
  poolable: boolean;
  mapping: { glAccountId: string; accountCode: string | null; accountName: string; source: 'manual' | 'auto' } | null;
}

/** A refused mapping save (unknown category, or not this company's active account). The route answers 400. */
export class CategoryMappingRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CategoryMappingRefusal';
  }
}

interface MappingDbRow {
  category_code: string; gl_account_id: string; mapping_source: 'manual' | 'auto';
  account_code: string | null; account_name: string;
}

export async function listCategoryMappings(companyId: string): Promise<{ listVersion: number; categories: CategoryMappingView[] }> {
  const rows = (await sql`
    SELECT m.category_code, m.gl_account_id, m.mapping_source, ga.account_code, ga.account_name
    FROM company_category_mappings m
    JOIN gl_accounts ga ON ga.id = m.gl_account_id AND ga.company_id = m.company_id
    WHERE m.company_id = ${companyId}::UUID
  `) as MappingDbRow[];
  const byCode = new Map(rows.map((r) => [r.category_code, r]));
  return {
    listVersion: MERCHANT_CATEGORY_LIST_VERSION,
    categories: MERCHANT_CATEGORIES.map((c) => {
      const r = byCode.get(c.code);
      return {
        code: c.code, label: c.label, poolable: c.poolable,
        mapping: r ? { glAccountId: String(r.gl_account_id), accountCode: r.account_code, accountName: r.account_name, source: r.mapping_source } : null,
      };
    }),
  };
}

/** Map one category to an account (or clear it with null). Refuses an unknown category or an account not this company's. */
export async function saveCategoryMapping(
  companyId: string, userId: string, categoryCode: string, glAccountId: string | null,
): Promise<void> {
  if (!merchantCategory(categoryCode)) throw new CategoryMappingRefusal(`Unknown category: ${categoryCode}`);
  if (glAccountId === null) {
    await sql`DELETE FROM company_category_mappings WHERE company_id = ${companyId}::UUID AND category_code = ${categoryCode}`;
    return;
  }
  const acct = (await sql`
    SELECT id FROM gl_accounts WHERE id = ${glAccountId}::UUID AND company_id = ${companyId}::UUID AND COALESCE(is_active, true)
  `) as Array<{ id: string }>;
  if (acct.length === 0) throw new CategoryMappingRefusal('That account is not an active account of this company');
  await sql`
    INSERT INTO company_category_mappings (company_id, category_code, gl_account_id, mapping_source, mapped_by)
    VALUES (${companyId}::UUID, ${categoryCode}, ${glAccountId}::UUID, 'manual', ${userId})
    ON CONFLICT (company_id, category_code) DO UPDATE
      SET gl_account_id = EXCLUDED.gl_account_id, mapping_source = 'manual', mapped_by = EXCLUDED.mapped_by, updated_at = now()
  `;
}

/**
 * Pure: the auto-map proposals. For each category not in `alreadyMapped`, the one account whose normalised
 * name equals an alias; a category two accounts match is `ambiguous` and left for a person.
 */
export function proposeAutoMappings(
  accounts: MappingAccount[], alreadyMapped: ReadonlySet<string>,
): { proposals: Array<{ categoryCode: string; glAccountId: string }>; ambiguous: string[] } {
  const proposals: Array<{ categoryCode: string; glAccountId: string }> = [];
  const ambiguous: string[] = [];
  const named = accounts.map((a) => ({ id: a.id, name: normaliseAccountName(a.accountName) }));
  for (const c of MERCHANT_CATEGORIES) {
    if (alreadyMapped.has(c.code)) continue;
    const aliases = new Set(c.aliases);
    const hits = [...new Set(named.filter((a) => aliases.has(a.name)).map((a) => a.id))];
    if (hits.length === 1) proposals.push({ categoryCode: c.code, glAccountId: hits[0]! });
    else if (hits.length > 1) ambiguous.push(c.code);
  }
  return { proposals, ambiguous };
}

export async function autoMapCategories(
  companyId: string, userId: string,
): Promise<{ mapped: number; ambiguous: string[] }> {
  const accounts = (await sql`
    SELECT ga.id, ga.account_code, ga.account_name FROM gl_accounts ga
    WHERE ga.company_id = ${companyId}::UUID AND COALESCE(ga.is_active, true)
      AND NOT EXISTS (SELECT 1 FROM gl_accounts ch WHERE ch.parent_account_id = ga.id AND ch.company_id = ga.company_id)
  `) as Array<{ id: string; account_code: string | null; account_name: string | null }>;
  const existing = (await sql`
    SELECT category_code FROM company_category_mappings WHERE company_id = ${companyId}::UUID
  `) as Array<{ category_code: string }>;
  const { proposals, ambiguous } = proposeAutoMappings(
    accounts.map((a) => ({ id: String(a.id), accountCode: a.account_code, accountName: a.account_name ?? '' })),
    new Set(existing.map((e) => e.category_code)),
  );
  if (proposals.length === 0) return { mapped: 0, ambiguous };
  const inserted = (await sql`
    INSERT INTO company_category_mappings (company_id, category_code, gl_account_id, mapping_source, mapped_by)
    SELECT ${companyId}::UUID, p.code, p.account_id, 'auto', ${userId}
    FROM unnest(${proposals.map((p) => p.categoryCode)}::TEXT[], ${proposals.map((p) => p.glAccountId)}::UUID[]) AS p(code, account_id)
    ON CONFLICT (company_id, category_code) DO NOTHING
    RETURNING category_code
  `) as Array<{ category_code: string }>;
  return { mapped: inserted.length, ambiguous };
}
