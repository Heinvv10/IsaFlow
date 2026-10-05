/**
 * Fleet records of a vehicle held as a fixed asset (mig 853): fuel fills (`fleet_fuel_transactions`) and services
 * (`fleet_service_history`). There is no vehicle table — a record hangs off `assets` by asset_id, and the composite
 * FK (asset_id, company_id) holds it to an asset of its own company.
 *
 * Every function takes company_id first and answers `null` / `not_found` for an asset that is missing OR another
 * company's — one answer for both.
 *
 * Delete REFUSES a record a bank line links to (`linked`, 409 at the route) instead of clearing the link: the record
 * is what that line's money is annotated with, and the asset page that deletes it cannot show the line, so silently
 * stripping the annotation from the bank screen is the wrong default. Unlink on the bank line first. The record is
 * locked FOR UPDATE (5 s budget) before the link count is read, so a link in flight (which holds it FOR KEY SHARE) is
 * waited for and counted; a link that starts after it waits for the delete and then finds no record (404).
 */
import { sql, type DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { underFlowLockBudget } from '../core/rowLockBudget';

export type FleetKind = 'fuel' | 'service';

interface FleetRecordBase {
  id: string; assetId: string; amount: number; odometerKm: number | null;
  supplierName: string | null; notes: string | null; createdAt: string;
  /** Bank lines that link to this record — a linked record cannot be deleted. */
  bankLinkCount: number;
}
export interface FuelRecord extends FleetRecordBase { fillDate: string; litres: number }
export interface ServiceRecord extends FleetRecordBase { serviceDate: string; description: string }

interface CommonInput { amount: number; odometerKm?: number | null; supplierName?: string | null; notes?: string | null }
export interface FuelInput extends CommonInput { fillDate: string; litres: number }
export interface ServiceInput extends CommonInput { serviceDate: string; description: string }

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function base(r: DbRow): FleetRecordBase {
  return {
    id: String(r.id), assetId: String(r.asset_id), amount: Number(r.amount), odometerKm: num(r.odometer_km),
    supplierName: str(r.supplier_name), notes: str(r.notes),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    bankLinkCount: Number(r.bank_link_count ?? 0),
  };
}
const toFuel = (r: DbRow): FuelRecord => ({ ...base(r), fillDate: fmtDate(r.fill_date), litres: Number(r.litres) });
const toService = (r: DbRow): ServiceRecord => ({ ...base(r), serviceDate: fmtDate(r.service_date), description: String(r.description) });

export async function assetInCompany(companyId: string, assetId: string): Promise<boolean> {
  const rows = (await sql`SELECT id FROM assets WHERE id = ${assetId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  return rows.length > 0;
}

export async function listFuelRecords(companyId: string, assetId: string): Promise<FuelRecord[] | null> {
  if (!(await assetInCompany(companyId, assetId))) return null;
  const rows = (await sql`
    SELECT f.*, (SELECT COUNT(*) FROM bank_transactions bt
                 WHERE bt.linked_fleet_fuel_id = f.id AND bt.company_id = f.company_id) AS bank_link_count
    FROM fleet_fuel_transactions f
    WHERE f.company_id = ${companyId}::UUID AND f.asset_id = ${assetId}::UUID
    ORDER BY f.fill_date DESC, f.created_at DESC`) as DbRow[];
  return rows.map(toFuel);
}

export async function listServiceRecords(companyId: string, assetId: string): Promise<ServiceRecord[] | null> {
  if (!(await assetInCompany(companyId, assetId))) return null;
  const rows = (await sql`
    SELECT s.*, (SELECT COUNT(*) FROM bank_transactions bt
                 WHERE bt.linked_fleet_service_id = s.id AND bt.company_id = s.company_id) AS bank_link_count
    FROM fleet_service_history s
    WHERE s.company_id = ${companyId}::UUID AND s.asset_id = ${assetId}::UUID
    ORDER BY s.service_date DESC, s.created_at DESC`) as DbRow[];
  return rows.map(toService);
}

export async function createFuelRecord(
  companyId: string, assetId: string, input: FuelInput, userId: string,
): Promise<FuelRecord | null> {
  if (!(await assetInCompany(companyId, assetId))) return null;
  const rows = (await sql`
    INSERT INTO fleet_fuel_transactions
      (company_id, asset_id, fill_date, litres, amount, odometer_km, supplier_name, notes, created_by)
    VALUES (${companyId}::UUID, ${assetId}::UUID, ${input.fillDate}::DATE, ${input.litres}, ${input.amount},
      ${input.odometerKm ?? null}, ${input.supplierName ?? null}, ${input.notes ?? null}, ${userId})
    RETURNING *`) as DbRow[];
  return toFuel(rows[0]!);
}

export async function createServiceRecord(
  companyId: string, assetId: string, input: ServiceInput, userId: string,
): Promise<ServiceRecord | null> {
  if (!(await assetInCompany(companyId, assetId))) return null;
  const rows = (await sql`
    INSERT INTO fleet_service_history
      (company_id, asset_id, service_date, description, amount, odometer_km, supplier_name, notes, created_by)
    VALUES (${companyId}::UUID, ${assetId}::UUID, ${input.serviceDate}::DATE, ${input.description}, ${input.amount},
      ${input.odometerKm ?? null}, ${input.supplierName ?? null}, ${input.notes ?? null}, ${userId})
    RETURNING *`) as DbRow[];
  return toService(rows[0]!);
}

export type FleetDeleteResult = 'deleted' | 'not_found' | 'linked';

/** Delete one record of `assetId` — refused while a bank line links to it (see the header). */
export async function deleteFleetRecord(
  companyId: string, assetId: string, kind: FleetKind, id: string,
): Promise<FleetDeleteResult> {
  const held = await underFlowLockBudget('This fleet record', async () => (kind === 'fuel'
    ? await sql`SELECT id FROM fleet_fuel_transactions
        WHERE id = ${id}::UUID AND asset_id = ${assetId}::UUID AND company_id = ${companyId}::UUID FOR UPDATE`
    : await sql`SELECT id FROM fleet_service_history
        WHERE id = ${id}::UUID AND asset_id = ${assetId}::UUID AND company_id = ${companyId}::UUID FOR UPDATE`) as DbRow[]);
  if (held.length === 0) return 'not_found';

  const links = (kind === 'fuel'
    ? await sql`SELECT COUNT(*) AS n FROM bank_transactions
        WHERE linked_fleet_fuel_id = ${id}::UUID AND company_id = ${companyId}::UUID`
    : await sql`SELECT COUNT(*) AS n FROM bank_transactions
        WHERE linked_fleet_service_id = ${id}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  if (Number(links[0]!.n) > 0) return 'linked';

  if (kind === 'fuel') {
    await sql`DELETE FROM fleet_fuel_transactions WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`;
  } else {
    await sql`DELETE FROM fleet_service_history WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`;
  }
  return 'deleted';
}
