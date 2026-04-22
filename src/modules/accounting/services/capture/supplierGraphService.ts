/**
 * Cross-tenant supplier graph — PRD-05 Phase 11.
 *
 * Writes canonical supplier templates to platform_shared when a tenant
 * onboards a supplier (with VAT reg or a distinctive invoice layout).
 * Reads anonymised signals when tenants load their supplier list, so a
 * brand-new tenant can auto-match invoices from the top SA suppliers
 * on day one without any of our existing tenants' invoice data leaking.
 *
 * Privacy invariants:
 *   - platform_shared.* contains ONLY public / anonymised data:
 *       canonical name, public VAT reg, first-4/last-4 bank digits,
 *       opaque embeddings, observation counts, fraud signals.
 *   - tenant_hash is FNV-1a(company_id) — one-way, not reversible.
 *   - Per-tenant opt-in via companies.share_anonymised_signals (default
 *     true; flipping off suppresses future writes but leaves prior
 *     observations in place — the tenant identity wasn't stored anyway).
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createHash } from 'crypto';

type Row = Record<string, unknown>;

// ─── Privacy helpers ──────────────────────────────────────────────────────────

/**
 * One-way tenant identifier for shared observations. FNV-1a is the same
 * scheme the Sentry scrub pipeline uses so the two surfaces never share a
 * reversible seed. 32-bit is plenty for de-dup within a template — we're
 * not trying to prevent a motivated attacker from enumerating 100k tenant
 * IDs, just from casually inferring "tenant X also uses supplier Y".
 */
export function tenantHash(companyId: string): string {
  const h = createHash('sha256').update('isaflow-shared-graph:' + companyId).digest('hex');
  return h.slice(0, 16);
}

/** Mask a bank account number for fraud signals — never store the middle. */
export function maskBankAccount(account: string): string | null {
  const clean = account.replace(/[^0-9]/g, '');
  if (clean.length < 6) return null;
  return clean.slice(0, 4) + '****' + clean.slice(-4);
}

/** Normalise supplier name for fuzzy matching: drop casing + non-alnum. */
export function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// ─── Shared-table reads ───────────────────────────────────────────────────────

export interface SharedTemplate {
  id: string;
  canonicalName: string;
  vatRegistration: string | null;
  countryCode: string;
  canonicalCategories: string[];
  observationsCount: number;
  fraudScore: number;
  firstSeenAt: string;
}

function mapTemplate(row: Row): SharedTemplate {
  return {
    id: row.id as string,
    canonicalName: row.canonical_name as string,
    vatRegistration: (row.vat_registration as string) ?? null,
    countryCode: (row.country_code as string) ?? 'ZA',
    canonicalCategories: (row.canonical_categories as string[]) ?? [],
    observationsCount: Number(row.observations_count ?? 0),
    fraudScore: row.fraud_score != null ? Number(row.fraud_score) : 0,
    firstSeenAt: String(row.first_seen_at),
  };
}

/**
 * Find a canonical template by VAT registration (exact) or normalised name.
 * Returns null when no confident match exists — callers should prefer
 * creating a new template over forcing a fuzzy match.
 */
export async function findTemplate(opts: {
  name?: string;
  vatRegistration?: string;
}): Promise<SharedTemplate | null> {
  if (opts.vatRegistration) {
    const rows = (await sql`
      SELECT * FROM platform_shared.supplier_templates
      WHERE vat_registration = ${opts.vatRegistration}
      LIMIT 1
    `) as Row[];
    if (rows.length > 0) return mapTemplate(rows[0]!);
  }
  if (opts.name) {
    const normalised = normaliseName(opts.name);
    const rows = (await sql`
      SELECT * FROM platform_shared.supplier_templates
      WHERE normalised_name = ${normalised}
      LIMIT 1
    `) as Row[];
    if (rows.length > 0) return mapTemplate(rows[0]!);
  }
  return null;
}

// ─── Shared-table writes ──────────────────────────────────────────────────────

export interface UpsertTemplateInput {
  companyId: string;                          // for opt-in check + observation hash
  canonicalName: string;
  vatRegistration?: string | null;
  countryCode?: string;
  canonicalCategories?: string[];
  knownBankAccounts?: string[];              // will be masked before write
  layoutEmbedding?: number[] | null;         // 768-dim, optional
  matchConfidence?: number;
}

/**
 * Upsert a template and record this tenant's observation. No-op (returns the
 * existing template without writing) if the tenant has opted out of shared
 * signals.
 */
export async function upsertTemplate(input: UpsertTemplateInput): Promise<SharedTemplate | null> {
  const optedIn = await isTenantSharing(input.companyId);

  const existing = await findTemplate({
    name: input.canonicalName,
    vatRegistration: input.vatRegistration ?? undefined,
  });

  if (!optedIn) {
    // Tenant opted out — we can still READ an existing template, but we
    // don't add a new one or observe from this tenant.
    return existing;
  }

  const maskedBanks = (input.knownBankAccounts ?? [])
    .map(maskBankAccount)
    .filter((b): b is string => b !== null);

  const embedding = input.layoutEmbedding
    ? `[${input.layoutEmbedding.join(',')}]`
    : null;

  let template: SharedTemplate;
  if (existing) {
    const rows = (await sql`
      UPDATE platform_shared.supplier_templates
      SET observations_count    = observations_count + 1,
          canonical_categories  = CASE
            WHEN array_length(${input.canonicalCategories ?? []}::text[], 1) IS NOT NULL
            THEN (
              SELECT ARRAY(SELECT DISTINCT unnest(canonical_categories || ${input.canonicalCategories ?? []}::text[]))
            )
            ELSE canonical_categories
          END,
          known_bank_accounts   = CASE
            WHEN array_length(${maskedBanks}::text[], 1) IS NOT NULL
            THEN (
              SELECT ARRAY(SELECT DISTINCT unnest(known_bank_accounts || ${maskedBanks}::text[]))
            )
            ELSE known_bank_accounts
          END,
          layout_embedding = COALESCE(${embedding}::vector, layout_embedding),
          updated_at = NOW()
      WHERE id = ${existing.id}::uuid
      RETURNING *
    `) as Row[];
    template = mapTemplate(rows[0]!);
  } else {
    const rows = (await sql`
      INSERT INTO platform_shared.supplier_templates (
        canonical_name, vat_registration, country_code,
        canonical_categories, known_bank_accounts, layout_embedding,
        observations_count
      ) VALUES (
        ${input.canonicalName}, ${input.vatRegistration ?? null},
        ${input.countryCode ?? 'ZA'},
        ${input.canonicalCategories ?? []}::text[],
        ${maskedBanks}::text[],
        ${embedding}::vector,
        1
      )
      RETURNING *
    `) as Row[];
    template = mapTemplate(rows[0]!);
  }

  // Record the anonymous observation (one row per template-per-tenant per
  // upsert). Swallow errors — observation is advisory, not load-bearing.
  try {
    await sql`
      INSERT INTO platform_shared.supplier_observations
        (supplier_template_id, tenant_hash, match_confidence)
      VALUES (${template.id}::uuid, ${tenantHash(input.companyId)},
              ${input.matchConfidence ?? null})
    `;
  } catch (err) {
    log.warn('shared-graph observation write failed', { err }, 'supplier-graph');
  }

  return template;
}

async function isTenantSharing(companyId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT share_anonymised_signals FROM companies WHERE id = ${companyId}::uuid
  `) as Row[];
  return rows[0]?.share_anonymised_signals !== false;
}

// ─── Link a tenant supplier to a shared template ──────────────────────────────

export async function linkSupplierToTemplate(
  companyId: string,
  supplierId: string,
  templateId: string,
): Promise<void> {
  await sql`
    UPDATE suppliers
    SET platform_template_id = ${templateId}::uuid
    WHERE id = ${supplierId}::uuid AND company_id = ${companyId}::uuid
  `;
}

// ─── Fraud-signal evaluation ──────────────────────────────────────────────────

export interface FraudAlert {
  id: string;
  supplierId: string;
  supplierName: string;
  signalType: 'vat_mismatch' | 'bank_change' | 'email_spoof' | 'layout_anomaly' | 'duplicate_vat';
  severity: 'info' | 'warning' | 'critical';
  evidence: Record<string, unknown>;
  status: 'pending' | 'dismissed' | 'confirmed';
  firstSeenAt: string;
}

function mapAlert(row: Row): FraudAlert {
  return {
    id: row.id as string,
    supplierId: row.supplier_id as string,
    supplierName: (row.supplier_name as string) ?? '',
    signalType: row.signal_type as FraudAlert['signalType'],
    severity: row.severity as FraudAlert['severity'],
    evidence: (row.evidence as Record<string, unknown>) ?? {},
    status: row.status as FraudAlert['status'],
    firstSeenAt: String(row.first_seen_at),
  };
}

/**
 * List active alerts for a company (joined with supplier name).
 */
export async function listAlerts(
  companyId: string,
  opts: { status?: string; limit?: number } = {},
): Promise<FraudAlert[]> {
  const rows = (await sql`
    SELECT fa.*, s.name AS supplier_name
    FROM fraud_alerts fa
    JOIN suppliers s ON s.id = fa.supplier_id
    WHERE fa.company_id = ${companyId}::uuid
      AND (${opts.status ?? null}::text IS NULL OR fa.status = ${opts.status ?? null})
    ORDER BY fa.first_seen_at DESC
    LIMIT ${opts.limit ?? 100}
  `) as Row[];
  return rows.map(mapAlert);
}

export async function dismissAlert(
  id: string,
  companyId: string,
  userId: string,
  reason?: string,
): Promise<boolean> {
  const rows = (await sql`
    UPDATE fraud_alerts
    SET status = 'dismissed', resolved_at = NOW(), resolved_by = ${userId},
        dismiss_reason = ${reason ?? null}
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
    RETURNING id
  `) as Array<{ id: string }>;
  return rows.length > 0;
}

export async function confirmAlert(
  id: string,
  companyId: string,
  userId: string,
): Promise<boolean> {
  const rows = (await sql`
    UPDATE fraud_alerts
    SET status = 'confirmed', resolved_at = NOW(), resolved_by = ${userId}
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
    RETURNING id
  `) as Array<{ id: string }>;
  return rows.length > 0;
}

/**
 * Nightly scan — for each linked supplier in this company, check the shared
 * graph for signals and upsert per-tenant alerts. Safe to run concurrently;
 * `ON CONFLICT (company_id, supplier_id, signal_type)` dedupes.
 */
export async function scanCompanyForFraud(companyId: string): Promise<{ created: number; refreshed: number }> {
  // Find suppliers that are linked to a shared template
  const suppliers = (await sql`
    SELECT s.id AS supplier_id, s.name, s.vat_number, s.platform_template_id
    FROM suppliers s
    WHERE s.company_id = ${companyId}::uuid
      AND s.platform_template_id IS NOT NULL
      AND s.is_active = true
  `) as Row[];

  if (suppliers.length === 0) return { created: 0, refreshed: 0 };

  let created = 0;
  let refreshed = 0;

  for (const sup of suppliers) {
    const templateId = sup.platform_template_id as string;
    const supplierVat = (sup.vat_number as string) ?? null;

    // Fetch the shared template + any active signals
    const templateRows = (await sql`
      SELECT * FROM platform_shared.supplier_templates
      WHERE id = ${templateId}::uuid
    `) as Row[];
    if (templateRows.length === 0) continue;
    const template = templateRows[0]!;

    const signals = (await sql`
      SELECT * FROM platform_shared.fraud_signals
      WHERE supplier_template_id = ${templateId}::uuid
        AND dismissed_at IS NULL
      ORDER BY first_seen_at DESC
    `) as Row[];

    // Rule A: VAT mismatch — canonical VAT vs supplier's own VAT
    if (template.vat_registration && supplierVat
        && template.vat_registration !== supplierVat.replace(/\s+/g, '')) {
      const result = await upsertAlert(companyId, sup.supplier_id as string, templateId,
        'vat_mismatch', 'warning', {
          canonicalVat: template.vat_registration,
          observedVat: supplierVat,
        });
      if (result === 'created') created++; else refreshed++;
    }

    // Rule B: surface any shared fraud_signals directly to the tenant
    for (const signal of signals) {
      const result = await upsertAlert(companyId, sup.supplier_id as string, templateId,
        signal.signal_type as string,
        signal.severity as string,
        signal.evidence as Record<string, unknown>);
      if (result === 'created') created++; else refreshed++;
    }
  }

  return { created, refreshed };
}

async function upsertAlert(
  companyId: string,
  supplierId: string,
  templateId: string,
  signalType: string,
  severity: string,
  evidence: Record<string, unknown>,
): Promise<'created' | 'refreshed'> {
  const rows = (await sql`
    INSERT INTO fraud_alerts
      (company_id, supplier_id, supplier_template_id, signal_type, severity, evidence)
    VALUES
      (${companyId}::uuid, ${supplierId}::uuid, ${templateId}::uuid,
       ${signalType}, ${severity}, ${JSON.stringify(evidence)}::jsonb)
    ON CONFLICT (company_id, supplier_id, signal_type)
    DO UPDATE SET
      severity = EXCLUDED.severity,
      evidence = EXCLUDED.evidence
    RETURNING (xmax = 0) AS inserted
  `) as Array<{ inserted: boolean }>;
  return rows[0]?.inserted ? 'created' : 'refreshed';
}
