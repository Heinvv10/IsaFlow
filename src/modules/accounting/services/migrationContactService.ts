/**
 * Migration Contact Service — Customers + Suppliers import
 * PRD: Customer Migration Wizard — Phase 1
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { updateSession } from './migrationService';
import type { ImportResult, MigrationError } from './migrationService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export interface CustomerImportRow {
  name: string;
  email?: string;
  phone?: string;
  vatNumber?: string;
  registrationNumber?: string;
  billingAddress?: string;
  contactPerson?: string;
  paymentTerms?: number;
  creditLimit?: number;
  notes?: string;
}

export interface SupplierImportRow {
  name: string;
  email?: string;
  phone?: string;
  vatNumber?: string;
  registrationNumber?: string;
  billingAddress?: string;
  contactPerson?: string;
  paymentTerms?: number;
  bankName?: string;
  bankAccountNumber?: string;
  bankBranchCode?: string;
  bankAccountType?: string;
  notes?: string;
}

export type DuplicateStrategy = 'skip' | 'overwrite' | 'merge';

// ── Customers ────────────────────────────────────────────────────────────────

export async function importCustomers(
  companyId: string,
  sessionId: string,
  customers: CustomerImportRow[],
  duplicateStrategy: DuplicateStrategy = 'skip',
): Promise<ImportResult> {
  const errors: MigrationError[] = [];
  let imported = 0;
  let skipped = 0;

  const existingRows = (await sql`
    SELECT id, name FROM customers WHERE company_id = ${companyId}::UUID
  `) as Row[];
  const existing = existingRows.map(r => ({ id: String(r.id), name: String(r.name) }));

  for (let i = 0; i < customers.length; i++) {
    const cust = customers[i]!;
    if (!cust.name?.trim()) {
      errors.push({ step: 'customers', row: i, field: 'name', message: 'Name is required' });
      skipped++;
      continue;
    }

    try {
      const duplicate = findDuplicate(cust.name, existing);

      if (duplicate && duplicateStrategy === 'skip') { skipped++; continue; }

      if (duplicate && duplicateStrategy === 'overwrite') {
        await sql`
          UPDATE customers SET
            email           = COALESCE(${cust.email ?? null}, email),
            phone           = COALESCE(${cust.phone ?? null}, phone),
            vat_number      = COALESCE(${cust.vatNumber ?? null}, vat_number),
            billing_address = COALESCE(${cust.billingAddress ?? null}, billing_address),
            contact_person  = COALESCE(${cust.contactPerson ?? null}, contact_person),
            payment_terms   = COALESCE(${cust.paymentTerms ?? null}, payment_terms),
            credit_limit    = COALESCE(${cust.creditLimit ?? null}, credit_limit)
          WHERE id = ${duplicate.id}::UUID AND company_id = ${companyId}::UUID
        `;
        imported++;
        continue;
      }

      await sql`
        INSERT INTO customers (
          company_id, name, email, phone, vat_number, registration_number,
          billing_address, contact_person, payment_terms, credit_limit, notes
        ) VALUES (
          ${companyId}::UUID, ${cust.name}, ${cust.email ?? null}, ${cust.phone ?? null},
          ${cust.vatNumber ?? null}, ${cust.registrationNumber ?? null},
          ${cust.billingAddress ?? null}, ${cust.contactPerson ?? null},
          ${cust.paymentTerms ?? 30}, ${cust.creditLimit ?? null}, ${cust.notes ?? null}
        )
      `;
      imported++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ step: 'customers', row: i, message: msg });
      skipped++;
    }
  }

  await updateSession(sessionId, companyId, { customersImported: imported, stepsCompleted: { customers: true } });
  log.info('Customer import complete', { companyId, imported, skipped }, 'migration');
  return { imported, skipped, errors };
}

// ── Suppliers ────────────────────────────────────────────────────────────────

export async function importSuppliers(
  companyId: string,
  sessionId: string,
  suppliers: SupplierImportRow[],
  duplicateStrategy: DuplicateStrategy = 'skip',
): Promise<ImportResult> {
  const errors: MigrationError[] = [];
  let imported = 0;
  let skipped = 0;

  const existingRows = (await sql`
    SELECT id, COALESCE(company_name, name) AS name FROM suppliers
    WHERE company_id = ${companyId}::UUID
  `) as Row[];
  const existing = existingRows.map(r => ({ id: String(r.id), name: String(r.name) }));

  for (let i = 0; i < suppliers.length; i++) {
    const sup = suppliers[i]!;
    if (!sup.name?.trim()) {
      errors.push({ step: 'suppliers', row: i, field: 'name', message: 'Name is required' });
      skipped++;
      continue;
    }

    try {
      const duplicate = findDuplicate(sup.name, existing);

      if (duplicate && duplicateStrategy === 'skip') { skipped++; continue; }

      if (duplicate && duplicateStrategy === 'overwrite') {
        await sql`
          UPDATE suppliers SET
            email               = COALESCE(${sup.email ?? null}, email),
            phone               = COALESCE(${sup.phone ?? null}, phone),
            vat_number          = COALESCE(${sup.vatNumber ?? null}, vat_number),
            bank_name           = COALESCE(${sup.bankName ?? null}, bank_name),
            bank_account_number = COALESCE(${sup.bankAccountNumber ?? null}, bank_account_number),
            bank_branch_code    = COALESCE(${sup.bankBranchCode ?? null}, bank_branch_code),
            bank_account_type   = COALESCE(${sup.bankAccountType ?? null}, bank_account_type)
          WHERE id = ${duplicate.id}::UUID AND company_id = ${companyId}::UUID
        `;
        imported++;
        continue;
      }

      await sql`
        INSERT INTO suppliers (
          company_id, name, email, phone, vat_number, registration_number,
          billing_address, contact_person, payment_terms,
          bank_name, bank_account_number, bank_branch_code, bank_account_type, notes
        ) VALUES (
          ${companyId}::UUID, ${sup.name}, ${sup.email ?? null}, ${sup.phone ?? null},
          ${sup.vatNumber ?? null}, ${sup.registrationNumber ?? null},
          ${sup.billingAddress ?? null}, ${sup.contactPerson ?? null},
          ${sup.paymentTerms ?? 30},
          ${sup.bankName ?? null}, ${sup.bankAccountNumber ?? null},
          ${sup.bankBranchCode ?? null}, ${sup.bankAccountType ?? null}, ${sup.notes ?? null}
        )
      `;
      imported++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ step: 'suppliers', row: i, message: msg });
      skipped++;
    }
  }

  await updateSession(sessionId, companyId, { suppliersImported: imported, stepsCompleted: { suppliers: true } });
  log.info('Supplier import complete', { companyId, imported, skipped }, 'migration');
  return { imported, skipped, errors };
}

// ── Duplicate detection ──────────────────────────────────────────────────────

function findDuplicate(
  name: string,
  existing: Array<{ id: string; name: string }>,
): { id: string; name: string } | null {
  const normalized = name.toLowerCase().trim();
  const exact = existing.find(e => e.name.toLowerCase().trim() === normalized);
  if (exact) return exact;

  for (const e of existing) {
    if (diceCoefficient(normalized, e.name.toLowerCase().trim()) >= 0.8) return e;
  }
  return null;
}

function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ba = new Set<string>(), bb = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) ba.add(a.substring(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) bb.add(b.substring(i, i + 2));
  let n = 0;
  for (const g of ba) { if (bb.has(g)) n++; }
  return (2 * n) / (ba.size + bb.size);
}
