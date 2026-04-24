/**
 * Employment Equity Act reporting (mig 456).
 *
 * Produces the level × race × gender matrix that feeds the EEA2 annual
 * return. Disability and foreign-national are reported as separate
 * pivots per level so the consumer UI can render them alongside.
 *
 * The occupational level master is a global seeded table (not per
 * company) because the 6 levels are statutory — a 7th "unspecified"
 * bucket catches employees that haven't been categorised yet so the
 * report total always matches headcount.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { recordEmployeeChange } from './payrollEmployeeHistoryService';

export interface OccupationalLevel {
  id: string;
  code: string;
  name: string;
  displayOrder: number;
}

export type Race = 'african' | 'coloured' | 'indian' | 'white' | 'foreign';
export type Gender = 'male' | 'female';

export interface EEA2Cell {
  race: Race;
  gender: Gender;
  count: number;
}

export interface EEA2LevelRow {
  levelId: string | null;
  levelCode: string | null;
  levelName: string | null;
  displayOrder: number;
  cells: EEA2Cell[];
  disabilityCount: number;
  foreignCount: number;
  total: number;
}

export interface EEA2Report {
  asOf: string;
  levels: EEA2LevelRow[];
  totals: {
    grandTotal: number;
    disabilityCount: number;
    foreignCount: number;
  };
}

const RACES: Race[] = ['african', 'coloured', 'indian', 'white', 'foreign'];
const GENDERS: Gender[] = ['male', 'female'];

export async function listOccupationalLevels(): Promise<OccupationalLevel[]> {
  const rows = (await sql`
    SELECT id, code, name, display_order
      FROM occupational_levels
     ORDER BY display_order, code
  `) as DbRow[];
  return rows.map(r => ({
    id: String(r.id),
    code: String(r.code),
    name: String(r.name),
    displayOrder: Number(r.display_order) || 0,
  }));
}

async function assertEmployeeInCompany(companyId: string, employeeId: string): Promise<DbRow> {
  const rows = (await sql`
    SELECT id, occupational_level_id FROM payroll_employees
     WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
     LIMIT 1
  `) as DbRow[];
  if (rows.length === 0 || !rows[0]) throw new Error(`Employee ${employeeId} not in company`);
  return rows[0];
}

export async function assignEmployeeOccupationalLevel(
  companyId: string,
  employeeId: string,
  levelId: string | null,
  userId?: string,
): Promise<void> {
  const emp = await assertEmployeeInCompany(companyId, employeeId);

  if (levelId !== null) {
    const rows = (await sql`
      SELECT id FROM occupational_levels WHERE id = ${levelId}::uuid LIMIT 1
    `) as DbRow[];
    if (rows.length === 0) throw new Error(`Occupational level ${levelId} not found`);
  }

  const oldValue = emp.occupational_level_id == null ? null : String(emp.occupational_level_id);

  await sql`
    UPDATE payroll_employees
       SET occupational_level_id = ${levelId}::uuid,
           updated_at = NOW()
     WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
  `;

  if (userId) {
    await recordEmployeeChange({
      companyId,
      employeeId,
      fieldName: 'occupational_level_id',
      oldValue,
      newValue: levelId,
      userId,
    });
  }
}

export async function eea2Report(companyId: string, asOf: string): Promise<EEA2Report> {
  const rows = (await sql`
    SELECT ol.id                                AS level_id,
           ol.code                              AS level_code,
           ol.name                              AS level_name,
           COALESCE(ol.display_order, 100)      AS display_order,
           e.equity_race                        AS race,
           e.equity_gender                      AS gender,
           e.equity_disability                  AS disability,
           e.is_foreign_national                AS foreign,
           COUNT(*)::int                        AS headcount
      FROM payroll_employees e
 LEFT JOIN occupational_levels ol ON ol.id = e.occupational_level_id
     WHERE e.company_id = ${companyId}::uuid
       AND e.status = 'active'
       AND (e.start_date IS NULL OR e.start_date <= ${asOf}::date)
       AND (e.end_date   IS NULL OR e.end_date   >= ${asOf}::date)
     GROUP BY ol.id, ol.code, ol.name, ol.display_order,
              e.equity_race, e.equity_gender, e.equity_disability, e.is_foreign_national
     ORDER BY display_order, ol.code
  `) as DbRow[];

  type LevelKey = string;
  const byLevel = new Map<LevelKey, EEA2LevelRow>();

  function levelKeyOf(r: DbRow): LevelKey {
    return r.level_code == null ? '__unspecified__' : String(r.level_code);
  }

  let grandTotal = 0;
  let grandDisability = 0;
  let grandForeign = 0;

  for (const r of rows) {
    const key = levelKeyOf(r);
    if (!byLevel.has(key)) {
      byLevel.set(key, {
        levelId: r.level_id == null ? null : String(r.level_id),
        levelCode: r.level_code == null ? null : String(r.level_code),
        levelName: r.level_name == null ? null : String(r.level_name),
        displayOrder: Number(r.display_order) || 100,
        cells: RACES.flatMap(race =>
          GENDERS.map(gender => ({ race, gender, count: 0 })),
        ),
        disabilityCount: 0,
        foreignCount: 0,
        total: 0,
      });
    }
    const level = byLevel.get(key)!;
    const race = r.race as Race | null;
    const gender = r.gender as Gender | null;
    const count = Number(r.headcount) || 0;
    if (race && gender) {
      const cell = level.cells.find(c => c.race === race && c.gender === gender);
      if (cell) cell.count += count;
    }
    if (r.disability === true) level.disabilityCount += count;
    if (r.foreign === true) level.foreignCount += count;
    level.total += count;
    grandTotal += count;
    if (r.disability === true) grandDisability += count;
    if (r.foreign === true) grandForeign += count;
  }

  const levels = Array.from(byLevel.values()).sort((a, b) => a.displayOrder - b.displayOrder);

  return {
    asOf,
    levels,
    totals: {
      grandTotal,
      disabilityCount: grandDisability,
      foreignCount: grandForeign,
    },
  };
}
