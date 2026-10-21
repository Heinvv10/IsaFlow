/**
 * The contact each Sage take-on document belongs to, by EXACT name (case and
 * outer spaces aside) among this company's customers / suppliers — never the
 * wizard's near-spelling match, which could land a Sage invoice on a
 * different existing contact. A name with no contact of exactly that name, or
 * with two, is an issue; the import refuses on it.
 *
 * Suppliers are named as the AP step names them: COALESCE(company_name, name).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import type { TakeOnIssue } from './sageTakeOnTypes';

const key = (name: string) => name.trim().toLowerCase();

function resolve(
  names: readonly string[], rows: DbRow[], kind: 'customer' | 'supplier', issues: TakeOnIssue[],
): Map<string, string> {
  const byName = new Map<string, string[]>();
  for (const r of rows) byName.set(key(String(r.name)), [...(byName.get(key(String(r.name))) ?? []), String(r.id)]);
  const out = new Map<string, string>();
  const area = kind === 'customer' ? 'receivables' : 'payables';
  for (const name of new Set(names)) {
    const ids = byName.get(key(name)) ?? [];
    if (ids.length === 1) out.set(name, ids[0]!);
    else {
      issues.push({
        severity: 'error', area,
        message: ids.length === 0
          ? `No ${kind} called exactly "${name}" is in IsaFlow to take its Sage documents.`
          : `IsaFlow has ${ids.length} ${kind}s called "${name}", so its Sage documents have no single home. Rename or merge them, then review again.`,
      });
    }
  }
  return out;
}

export async function exactContactIds(
  companyId: string, customerNames: readonly string[], supplierNames: readonly string[],
): Promise<{ customers: Map<string, string>; suppliers: Map<string, string>; issues: TakeOnIssue[] }> {
  const issues: TakeOnIssue[] = [];
  const customers = customerNames.length === 0 ? new Map<string, string>() : resolve(customerNames, (await sql`
    SELECT id, name FROM customers WHERE company_id = ${companyId}::UUID
  `) as DbRow[], 'customer', issues);
  const suppliers = supplierNames.length === 0 ? new Map<string, string>() : resolve(supplierNames, (await sql`
    SELECT id, COALESCE(company_name, name) AS name FROM suppliers WHERE company_id = ${companyId}::UUID
  `) as DbRow[], 'supplier', issues);
  return { customers, suppliers, issues };
}
