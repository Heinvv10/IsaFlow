/**
 * Seed the ISAFlow demo company with enough data to exercise every
 * PRD-05 surface during the browser-QA pass. Idempotent: re-running
 * produces the same state.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... bun scripts/seed-prd05-qa-data.ts
 */

import pg from 'pg';
import { createHash } from 'crypto';

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_USER_ID = 'd8a83148-cca6-4951-b13a-66322e4d5dbc';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required');

const client = new pg.Client({ connectionString: url });

async function q<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await client.query(sql, params);
  return r.rows as T[];
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

async function main() {
  await client.connect();
  console.log('Connected to demo DB');

  // ── 1. Suppliers (3 that we'll need in multiple phases) ────────────────────
  const suppliers: Array<{ name: string; vat: string }> = [
    { name: 'Telkom SA SOC Ltd',       vat: '4000145634' },
    { name: 'Eskom Holdings SOC Ltd',  vat: '4000015215' },
    { name: 'Cape Office Supplies CC', vat: '4000987654' },
  ];

  const supplierIds: Record<string, string> = {};
  for (const s of suppliers) {
    const [row] = await q<{ id: string }>(`
      INSERT INTO suppliers (company_id, name, vat_number, is_active, payment_terms)
      VALUES ($1::uuid, $2, $3, true, 30)
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [COMPANY_ID, s.name, s.vat]);

    const id = row?.id ?? (await q<{ id: string }>(`
      SELECT id FROM suppliers WHERE company_id=$1::uuid AND name=$2 LIMIT 1
    `, [COMPANY_ID, s.name]))[0]!.id;

    supplierIds[s.name] = id;
  }
  console.log('✓ 3 suppliers');

  // ── 2. Supplier rules (Phase 3 — auto-publish + coding defaults) ───────────
  // Pick an expense GL account
  const [expenseAcc] = await q<{ id: string; code: string }>(`
    SELECT id, account_code AS code FROM gl_accounts
    WHERE company_id=$1::uuid AND account_type='expense' AND level >= 3
    ORDER BY level DESC, display_order ASC LIMIT 1
  `, [COMPANY_ID]);

  if (!expenseAcc) throw new Error('No expense GL account found');

  for (const name of Object.keys(supplierIds)) {
    await q(`
      INSERT INTO supplier_coding_rules (
        company_id, supplier_id, default_gl_account_id, default_vat_code,
        auto_publish, auto_publish_max_amount, auto_publish_min_confidence
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'STD', true, 10000, 0.92)
      ON CONFLICT (company_id, supplier_id) DO UPDATE SET
        default_gl_account_id = EXCLUDED.default_gl_account_id,
        auto_publish = EXCLUDED.auto_publish,
        auto_publish_max_amount = EXCLUDED.auto_publish_max_amount
    `, [COMPANY_ID, supplierIds[name], expenseAcc.id]);
  }
  console.log('✓ 3 supplier coding rules (auto-publish on)');

  // ── 3. Supplier expectations (Phase 6) ─────────────────────────────────────
  for (const name of ['Telkom SA SOC Ltd', 'Eskom Holdings SOC Ltd']) {
    await q(`
      INSERT INTO supplier_expectations (
        company_id, supplier_id, cadence, expected_day_of_month,
        expected_amount, amount_stddev, last_invoice_date, last_invoice_amount,
        sample_size, status
      ) VALUES ($1::uuid, $2::uuid, 'monthly', 25, 1800.00, 150.00,
                CURRENT_DATE - INTERVAL '40 days', 1820.00, 6, 'locked')
      ON CONFLICT (company_id, supplier_id) DO UPDATE SET
        cadence = EXCLUDED.cadence, expected_amount = EXCLUDED.expected_amount
    `, [COMPANY_ID, supplierIds[name]]);

    // One overdue alert each for QA
    await q(`
      INSERT INTO expected_invoice_alerts (
        company_id, supplier_id, expected_by, expected_amount, status
      ) VALUES ($1::uuid, $2::uuid, CURRENT_DATE - INTERVAL '10 days', 1800.00, 'pending')
      ON CONFLICT DO NOTHING
    `, [COMPANY_ID, supplierIds[name]]);
  }
  console.log('✓ 2 supplier expectations + 2 pending overdue alerts');

  // ── 4. Mirror inbox connection (Phase 9) — inactive so no scan runs ────────
  await q(`
    INSERT INTO imap_mirror_connections (
      company_id, provider, display_name, account_email,
      imap_host, imap_port, imap_use_tls, imap_username, imap_password_enc,
      allowed_senders, folder, scan_interval_minutes, status
    ) VALUES ($1::uuid, 'imap', 'QA Demo Mailbox', 'qa-demo@example.co.za',
              'imap.example.co.za', 993, true, 'qa-demo',
              'test-encrypted-placeholder',
              ARRAY['@telkom.co.za','@eskom.co.za']::text[],
              'INBOX', 60, 'disconnected')
    ON CONFLICT (company_id, account_email) DO NOTHING
  `, [COMPANY_ID]);
  console.log('✓ 1 IMAP mirror connection (disconnected)');

  // ── 5. Expense claim (Phase 10) — in DRAFT so QA can walk the flow ─────────
  const [{ id: empId }] = await q<{ id: string }>(`
    SELECT id FROM payroll_employees WHERE company_id=$1::uuid LIMIT 1
  `, [COMPANY_ID]);

  const claimNumber = 'CL-QA-DEMO';
  const [existingClaim] = await q<{ id: string }>(`
    SELECT id FROM expense_claims WHERE company_id=$1::uuid AND claim_number=$2
  `, [COMPANY_ID, claimNumber]);

  let claimId = existingClaim?.id;
  if (!claimId) {
    const [c] = await q<{ id: string }>(`
      INSERT INTO expense_claims (
        company_id, employee_id, claim_number, claim_date,
        title, description, status, total_amount, total_vat, created_by
      ) VALUES ($1::uuid, $2::uuid, $3, CURRENT_DATE, 'QA demo claim',
                'Pre-seeded for browser QA walkthrough', 'draft',
                345.00, 45.00, $4)
      RETURNING id
    `, [COMPANY_ID, empId, claimNumber, ADMIN_USER_ID]);
    claimId = c!.id;

    await q(`
      INSERT INTO expense_claim_lines (
        claim_id, company_id, line_date, description, merchant,
        amount, vat_amount, vat_code, gl_account_id
      ) VALUES ($1::uuid, $2::uuid, CURRENT_DATE, 'Uber to client', 'Uber',
                230.00, 30.00, 'STD', $3::uuid),
               ($1::uuid, $2::uuid, CURRENT_DATE, 'Mileage Sandton → Pretoria', NULL,
                115.00, 15.00, 'STD', $3::uuid)
    `, [claimId, COMPANY_ID, expenseAcc.id]);
  }
  console.log(`✓ expense claim ${claimNumber} in draft (2 lines, R345 total)`);

  // ── 6. Fraud scenario (Phase 11) ───────────────────────────────────────────
  // Seed canonical Eskom template with VAT 4000015215
  const normalisedEskom = 'eskomholdingssocltd';
  const [existingTemplate] = await q<{ id: string }>(`
    SELECT id FROM platform_shared.supplier_templates WHERE normalised_name=$1 LIMIT 1
  `, [normalisedEskom]);

  let templateId = existingTemplate?.id;
  if (!templateId) {
    const [t] = await q<{ id: string }>(`
      INSERT INTO platform_shared.supplier_templates (
        canonical_name, vat_registration, country_code,
        canonical_categories, observations_count
      ) VALUES ('Eskom Holdings SOC Ltd', '4000015215', 'ZA',
                ARRAY['5450 Electricity']::text[], 5)
      RETURNING id
    `);
    templateId = t!.id;
  }

  // Create a supplier WITH WRONG VAT to trigger the mismatch
  const [existingBad] = await q<{ id: string }>(`
    SELECT id FROM suppliers WHERE company_id=$1::uuid AND name=$2 LIMIT 1
  `, [COMPANY_ID, 'Eskom Holdings SOC Ltd (QA FRAUD)']);

  let badSupId = existingBad?.id;
  if (!badSupId) {
    const [s] = await q<{ id: string }>(`
      INSERT INTO suppliers (company_id, name, vat_number, is_active, platform_template_id, payment_terms)
      VALUES ($1::uuid, 'Eskom Holdings SOC Ltd (QA FRAUD)', '9999999999', true, $2::uuid, 30)
      RETURNING id
    `, [COMPANY_ID, templateId]);
    badSupId = s!.id;
  } else {
    await q(`UPDATE suppliers SET platform_template_id=$2::uuid WHERE id=$1::uuid`, [badSupId, templateId]);
  }

  // Insert/refresh the fraud alert
  await q(`
    INSERT INTO fraud_alerts (
      company_id, supplier_id, supplier_template_id,
      signal_type, severity, evidence, status
    ) VALUES ($1::uuid, $2::uuid, $3::uuid,
              'vat_mismatch', 'warning',
              '{"canonicalVat":"4000015215","observedVat":"9999999999"}'::jsonb,
              'pending')
    ON CONFLICT (company_id, supplier_id, signal_type) DO UPDATE SET
      evidence = EXCLUDED.evidence, status = 'pending'
  `, [COMPANY_ID, badSupId, templateId]);
  console.log('✓ platform_shared.supplier_templates + pending VAT-mismatch alert');

  // ── 7. Audit pack (Phase 12) — pre-built so QA can click download ──────────
  const [existingPack] = await q<{ id: string }>(`
    SELECT id FROM audit_trail_exports
    WHERE company_id=$1::uuid
      AND period_start=$2::date AND period_end=$3::date
  `, [COMPANY_ID, '2026-03-01', '2026-03-31']);

  if (!existingPack) {
    // Just insert a ready row so the list has an entry; the actual PDF
    // will be regenerated on demand via the real build endpoint.
    await q(`
      INSERT INTO audit_trail_exports (
        company_id, period_start, period_end, status,
        je_count, line_count, document_count,
        total_debits, total_credits, pdf_storage_bucket, pdf_storage_path,
        pdf_sha256, requested_by
      ) VALUES ($1::uuid, '2026-03-01'::date, '2026-03-31'::date, 'ready',
                36, 86, 0, 1877865.87, 1877865.87,
                'captured-documents', $2,
                $3, $4)
    `, [
      COMPANY_ID,
      `${COMPANY_ID}/audit-qa-seed`,
      hash('qa-seed-placeholder'),
      ADMIN_USER_ID,
    ]);
  }
  console.log('✓ 1 seeded audit pack (March 2026)');

  // ── 8. Capture inbox — make sure the address row exists ────────────────────
  await q(`
    INSERT INTO capture_inboxes (company_id, channel, address, is_active)
    SELECT $1::uuid, 'email', 'cap-qa@inbox.isaflow.co.za', true
    WHERE NOT EXISTS (
      SELECT 1 FROM capture_inboxes
      WHERE company_id=$1::uuid AND channel='email'
    )
  `, [COMPANY_ID]);
  console.log('✓ capture email inbox address');

  console.log('\nSeed complete — ready for browser QA.');
  await client.end();
}

main().catch(async (err) => {
  console.error('Seed failed:', err);
  await client.end();
  process.exit(1);
});
