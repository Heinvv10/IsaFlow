/**
 * Supplier Coding Rules Service
 * CRUD for per-(company, supplier) default coding + auto-publish toggles.
 * Learning loop: records coding history and promotes auto_publish once
 * PROMOTION_THRESHOLD consecutive codings match the rule defaults.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// ── Constants ────────────────────────────────────────────────────────────────

const PROMOTION_THRESHOLD = 5;

// ── Types ────────────────────────────────────────────────────────────────────

export interface SupplierRule {
  id: string;
  companyId: string;
  supplierId: string;
  supplierName?: string | null;
  defaultGlAccountId: string | null;
  defaultGlAccountCode?: string | null;
  defaultGlAccountName?: string | null;
  defaultVatCode: string | null;
  defaultCostCentreId: string | null;
  defaultProjectId: string | null;
  autoPublish: boolean;
  autoPublishMaxAmount: number | null;
  autoPublishMinConfidence: number;
  requirePoMatch: boolean;
  learnedSampleCount: number;
  learnedFromLastCorrectionAt: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CodingEntry {
  supplierId: string;
  supplierInvoiceId: string | null;
  glAccountId: string | null;
  vatCode: string | null;
  costCentreId: string | null;
  projectId: string | null;
  postedBy: string; // 'human:<uid>' | 'ai:...' | 'rule:<id>'
}

type Row = Record<string, unknown>;

// ── Mapper ───────────────────────────────────────────────────────────────────

function mapRow(row: Row): SupplierRule {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    supplierId: String(row.supplier_id),
    supplierName: row.supplier_name ? String(row.supplier_name) : null,
    defaultGlAccountId: row.default_gl_account_id ? String(row.default_gl_account_id) : null,
    defaultGlAccountCode: row.default_gl_account_code ? String(row.default_gl_account_code) : null,
    defaultGlAccountName: row.default_gl_account_name ? String(row.default_gl_account_name) : null,
    defaultVatCode: row.default_vat_code ? String(row.default_vat_code) : null,
    defaultCostCentreId: row.default_cost_centre_id ? String(row.default_cost_centre_id) : null,
    defaultProjectId: row.default_project_id ? String(row.default_project_id) : null,
    autoPublish: Boolean(row.auto_publish),
    autoPublishMaxAmount: row.auto_publish_max_amount != null ? Number(row.auto_publish_max_amount) : null,
    autoPublishMinConfidence: Number(row.auto_publish_min_confidence),
    requirePoMatch: Boolean(row.require_po_match),
    learnedSampleCount: Number(row.learned_sample_count),
    learnedFromLastCorrectionAt: row.learned_from_last_correction_at
      ? String(row.learned_from_last_correction_at)
      : null,
    updatedBy: row.updated_by ? String(row.updated_by) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function listRules(companyId: string): Promise<SupplierRule[]> {
  const rows = (await sql`
    SELECT r.*,
           s.name        AS supplier_name,
           ga.account_code AS default_gl_account_code,
           ga.account_name AS default_gl_account_name
    FROM supplier_coding_rules r
    JOIN suppliers s       ON s.id = r.supplier_id AND s.company_id = ${companyId}::uuid
    LEFT JOIN gl_accounts ga ON ga.id = r.default_gl_account_id
    WHERE r.company_id = ${companyId}::uuid
    ORDER BY r.updated_at DESC
  `) as Row[];
  return rows.map(mapRow);
}

export async function getRule(
  companyId: string,
  supplierId: string,
): Promise<SupplierRule | null> {
  const rows = (await sql`
    SELECT r.*,
           s.name        AS supplier_name,
           ga.account_code AS default_gl_account_code,
           ga.account_name AS default_gl_account_name
    FROM supplier_coding_rules r
    JOIN suppliers s       ON s.id = r.supplier_id AND s.company_id = ${companyId}::uuid
    LEFT JOIN gl_accounts ga ON ga.id = r.default_gl_account_id
    WHERE r.company_id = ${companyId}::uuid
      AND r.supplier_id = ${supplierId}::uuid
    LIMIT 1
  `) as Row[];
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function upsertRule(
  companyId: string,
  supplierId: string,
  patch: Partial<SupplierRule>,
  userId: string,
): Promise<SupplierRule> {
  const rows = (await sql`
    INSERT INTO supplier_coding_rules (
      company_id, supplier_id,
      default_gl_account_id, default_vat_code,
      default_cost_centre_id, default_project_id,
      auto_publish, auto_publish_max_amount, auto_publish_min_confidence,
      require_po_match, updated_by
    ) VALUES (
      ${companyId}::uuid, ${supplierId}::uuid,
      ${patch.defaultGlAccountId ?? null}::uuid,
      ${patch.defaultVatCode ?? null},
      ${patch.defaultCostCentreId ?? null}::uuid,
      ${patch.defaultProjectId ?? null}::uuid,
      ${patch.autoPublish ?? false},
      ${patch.autoPublishMaxAmount ?? null},
      ${patch.autoPublishMinConfidence ?? 0.95},
      ${patch.requirePoMatch ?? false},
      ${userId}::uuid
    )
    ON CONFLICT (company_id, supplier_id) DO UPDATE SET
      default_gl_account_id       = COALESCE(EXCLUDED.default_gl_account_id,       supplier_coding_rules.default_gl_account_id),
      default_vat_code            = COALESCE(EXCLUDED.default_vat_code,            supplier_coding_rules.default_vat_code),
      default_cost_centre_id      = COALESCE(EXCLUDED.default_cost_centre_id,      supplier_coding_rules.default_cost_centre_id),
      default_project_id          = COALESCE(EXCLUDED.default_project_id,          supplier_coding_rules.default_project_id),
      auto_publish                = CASE WHEN EXCLUDED.auto_publish IS DISTINCT FROM supplier_coding_rules.auto_publish
                                         THEN EXCLUDED.auto_publish
                                         ELSE supplier_coding_rules.auto_publish END,
      auto_publish_max_amount     = COALESCE(EXCLUDED.auto_publish_max_amount,     supplier_coding_rules.auto_publish_max_amount),
      auto_publish_min_confidence = COALESCE(EXCLUDED.auto_publish_min_confidence, supplier_coding_rules.auto_publish_min_confidence),
      require_po_match            = EXCLUDED.require_po_match,
      updated_by                  = EXCLUDED.updated_by,
      updated_at                  = NOW()
    RETURNING *
  `) as Row[];

  const rule = rows[0];
  if (!rule) throw new Error('upsert returned no row');
  log.info('Upserted supplier coding rule', { companyId, supplierId }, 'supplier-rules');
  return mapRow(rule);
}

export async function deleteRule(companyId: string, supplierId: string): Promise<void> {
  await sql`
    DELETE FROM supplier_coding_rules
    WHERE company_id = ${companyId}::uuid
      AND supplier_id = ${supplierId}::uuid
  `;
  log.info('Deleted supplier coding rule', { companyId, supplierId }, 'supplier-rules');
}

// ── Learning loop ─────────────────────────────────────────────────────────────

export async function recordCoding(
  companyId: string,
  entry: CodingEntry,
): Promise<{ promoted: boolean; sampleCount: number }> {
  // 1. Append history row
  await sql`
    INSERT INTO supplier_coding_history (
      company_id, supplier_id, supplier_invoice_id,
      gl_account_id, vat_code, cost_centre_id, project_id, posted_by
    ) VALUES (
      ${companyId}::uuid,
      ${entry.supplierId}::uuid,
      ${entry.supplierInvoiceId ?? null}::uuid,
      ${entry.glAccountId ?? null}::uuid,
      ${entry.vatCode ?? null},
      ${entry.costCentreId ?? null}::uuid,
      ${entry.projectId ?? null}::uuid,
      ${entry.postedBy}
    )
  `;

  // 2. Load current rule (may not exist yet)
  const rule = await getRule(companyId, entry.supplierId);

  const glMatches =
    rule !== null &&
    (rule.defaultGlAccountId ?? null) === (entry.glAccountId ?? null);

  if (rule === null) {
    // No rule yet. Seed one automatically when the posting carries a real
    // coding signal (non-null GL account) — this is the human-correction path
    // that trains the rule. AI-pipeline postings arrive with null glAccountId
    // and intentionally don't seed a rule with no coding content.
    if (entry.glAccountId !== null) {
      await sql`
        INSERT INTO supplier_coding_rules (
          company_id, supplier_id,
          default_gl_account_id, default_vat_code,
          default_cost_centre_id, default_project_id,
          learned_sample_count, learned_from_last_correction_at
        ) VALUES (
          ${companyId}::uuid, ${entry.supplierId}::uuid,
          ${entry.glAccountId}::uuid,
          ${entry.vatCode ?? null},
          ${entry.costCentreId ?? null}::uuid,
          ${entry.projectId ?? null}::uuid,
          1, NOW()
        )
        ON CONFLICT (company_id, supplier_id) DO NOTHING
      `;
      log.info('Auto-seeded supplier coding rule from first human coding', {
        companyId, supplierId: entry.supplierId, glAccountId: entry.glAccountId,
      }, 'supplier-rules');
      return { promoted: false, sampleCount: 1 };
    }

    // Null coding — history recorded, no rule to promote.
    return { promoted: false, sampleCount: 0 };
  }

  // 3. Drift detection: if GL account changed, reset sample count and update defaults
  if (!glMatches) {
    await sql`
      UPDATE supplier_coding_rules SET
        default_gl_account_id = ${entry.glAccountId ?? null}::uuid,
        default_vat_code      = ${entry.vatCode ?? null},
        learned_sample_count  = 1,
        learned_from_last_correction_at = NOW(),
        updated_at = NOW()
      WHERE company_id = ${companyId}::uuid
        AND supplier_id = ${entry.supplierId}::uuid
    `;
    log.info('Supplier coding drift detected — rule defaults updated', {
      companyId,
      supplierId: entry.supplierId,
      oldGl: rule.defaultGlAccountId,
      newGl: entry.glAccountId,
    }, 'supplier-rules');
    return { promoted: false, sampleCount: 1 };
  }

  // 4. GL matches — increment sample count
  const newCount = rule.learnedSampleCount + 1;
  const shouldPromote = !rule.autoPublish && newCount >= PROMOTION_THRESHOLD;

  await sql`
    UPDATE supplier_coding_rules SET
      learned_sample_count = ${newCount},
      auto_publish         = ${shouldPromote ? true : rule.autoPublish},
      updated_at           = NOW()
    WHERE company_id = ${companyId}::uuid
      AND supplier_id = ${entry.supplierId}::uuid
  `;

  if (shouldPromote) {
    log.info('Supplier coding rule promoted to auto_publish', {
      companyId,
      supplierId: entry.supplierId,
      sampleCount: newCount,
    }, 'supplier-rules');
  }

  return { promoted: shouldPromote, sampleCount: newCount };
}
