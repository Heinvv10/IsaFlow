/**
 * Rows of migration 949's driver tables (Budgets P4 spec §5): a version's driver lines and its
 * planned hires. company_id on every statement; writes run in the caller's transaction after it
 * took the version lock (`takeVersion`, the compare-and-set), so the lock trigger (BV001) is only a backstop.
 *
 * DB ↔ app: NUMERIC rand is read as a number (NUMERIC(15,2) reads exactly) and written from integer
 * cents divided in NUMERIC, as the grid save does, so no float reaches a column; DATE 'YYYY-MM-01'
 * ↔ 'YYYY-MM'; `rounding_unit` ↔ `rounding`.
 */
import { sql, type DbRow } from '@/lib/neon';
import type { RoundingUnit } from '../grid/cents';
import { toCents } from '../grid/cents';
import { tokenSql } from '../gridErrors';
import { monthKeyToDate } from '../../reports/budgetPeriodWindow';
import type { Band } from '../grid/subtotals';
import type { DriverKind } from './driverTypes';
import type { DriverGrain, DriverLine, SectionScope, StoredDriverLine } from './driverLine';

const id = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const month = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const cents = (rand: number | null): number | null => (rand === null ? null : toCents(rand));
const date = (m: string | null): string | null => (m === null ? null : monthKeyToDate(m));

const LINE_COLUMNS = () => sql`
  id::text AS id, gl_account_id::text AS gl_account_id, cc1_id::text AS cc1_id, cc2_id::text AS cc2_id, bu_id::text AS bu_id,
  kind, to_char(from_month, 'YYYY-MM') AS from_month, to_char(to_month, 'YYYY-MM') AS to_month, amount::text AS amount, pct::text AS pct,
  ref_gl_account_id::text AS ref_gl_account_id, ref_cc1_id::text AS ref_cc1_id, ref_cc2_id::text AS ref_cc2_id, ref_bu_id::text AS ref_bu_id,
  ref_section, ref_scope, to_char(base_month, 'YYYY-MM') AS base_month, headcount_cost_centre_id::text AS headcount_cost_centre_id,
  rounding_unit, ${tokenSql()} AS token`;

function lineOf(r: DbRow): StoredDriverLine {
  const ref = id(r.ref_gl_account_id);
  return {
    id: String(r.id), glAccountId: String(r.gl_account_id), cc1Id: id(r.cc1_id), cc2Id: id(r.cc2_id), buId: id(r.bu_id),
    kind: String(r.kind) as DriverKind, fromMonth: String(r.from_month), toMonth: String(r.to_month),
    amount: r.amount === null ? null : Number(r.amount), pct: r.pct === null ? null : Number(r.pct),
    ref: ref === null ? null : { glAccountId: ref, cc1Id: id(r.ref_cc1_id), cc2Id: id(r.ref_cc2_id), buId: id(r.ref_bu_id) },
    section: r.ref_section === null ? null : (String(r.ref_section) as Band),
    scope: r.ref_scope === null ? null : (String(r.ref_scope) as SectionScope),
    baseMonth: month(r.base_month), headcountCostCentreId: id(r.headcount_cost_centre_id),
    rounding: Number(r.rounding_unit) as RoundingUnit, updatedAt: String(r.token),
  };
}

/** The version's driver lines, in a stable order (account, grain). */
export async function listDriverLines(companyId: string, versionId: string): Promise<StoredDriverLine[]> {
  const rows = (await sql`
    SELECT ${LINE_COLUMNS()} FROM budget_driver_lines
     WHERE company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID
     ORDER BY gl_account_id, cc1_id NULLS FIRST, cc2_id NULLS FIRST, bu_id NULLS FIRST
  `) as DbRow[];
  return rows.map(lineOf);
}

/** Sets the row's ONE driver (insert, or replace the one it has). Returns the stored line and whether it replaced one. */
export async function upsertDriverLine(
  companyId: string, versionId: string, userId: string, line: DriverLine,
): Promise<{ line: StoredDriverLine; replaced: boolean }> {
  const ref = line.ref;
  const rows = (await sql`
    INSERT INTO budget_driver_lines (
      company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id, kind, from_month, to_month, amount, pct,
      ref_gl_account_id, ref_cc1_id, ref_cc2_id, ref_bu_id, ref_section, ref_scope, base_month, headcount_cost_centre_id,
      rounding_unit, created_by)
    VALUES (
      ${companyId}::UUID, ${versionId}::UUID, ${line.glAccountId}::UUID, ${line.cc1Id}::UUID, ${line.cc2Id}::UUID, ${line.buId}::UUID,
      ${line.kind}, ${date(line.fromMonth)}::DATE, ${date(line.toMonth)}::DATE, ${cents(line.amount)}::BIGINT::NUMERIC / 100, ${line.pct}::NUMERIC,
      ${ref?.glAccountId ?? null}::UUID, ${ref?.cc1Id ?? null}::UUID, ${ref?.cc2Id ?? null}::UUID, ${ref?.buId ?? null}::UUID,
      ${line.section}, ${line.scope}, ${date(line.baseMonth)}::DATE, ${line.headcountCostCentreId}::UUID, ${line.rounding}::SMALLINT, ${userId})
    ON CONFLICT ON CONSTRAINT budget_driver_lines_one_per_row DO UPDATE SET
      kind = EXCLUDED.kind, from_month = EXCLUDED.from_month, to_month = EXCLUDED.to_month, amount = EXCLUDED.amount, pct = EXCLUDED.pct,
      ref_gl_account_id = EXCLUDED.ref_gl_account_id, ref_cc1_id = EXCLUDED.ref_cc1_id, ref_cc2_id = EXCLUDED.ref_cc2_id,
      ref_bu_id = EXCLUDED.ref_bu_id, ref_section = EXCLUDED.ref_section, ref_scope = EXCLUDED.ref_scope,
      base_month = EXCLUDED.base_month, headcount_cost_centre_id = EXCLUDED.headcount_cost_centre_id,
      rounding_unit = EXCLUDED.rounding_unit, updated_by = ${userId}
    RETURNING ${LINE_COLUMNS()}, (xmax <> 0) AS replaced
  `) as DbRow[];
  return { line: lineOf(rows[0]!), replaced: Boolean(rows[0]!.replaced) };
}

/** Deletes one driver line of the version; returns it, or null when the version has no such line. */
export async function deleteDriverLine(companyId: string, versionId: string, driverId: string): Promise<StoredDriverLine | null> {
  const rows = (await sql`
    DELETE FROM budget_driver_lines
     WHERE id = ${driverId}::UUID AND company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID
    RETURNING ${LINE_COLUMNS()}
  `) as DbRow[];
  return rows[0] ? lineOf(rows[0]) : null;
}

/** The row's driver line, or null. */
export async function driverLineOfRow(companyId: string, versionId: string, g: DriverGrain): Promise<StoredDriverLine | null> {
  const rows = (await sql`
    SELECT ${LINE_COLUMNS()} FROM budget_driver_lines
     WHERE company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID AND gl_account_id = ${g.glAccountId}::UUID
       AND cc1_id IS NOT DISTINCT FROM ${g.cc1Id}::UUID AND cc2_id IS NOT DISTINCT FROM ${g.cc2Id}::UUID
       AND bu_id IS NOT DISTINCT FROM ${g.buId}::UUID
  `) as DbRow[];
  return rows[0] ? lineOf(rows[0]) : null;
}

// ── Planned hires ──────────────────────────────────────────────────────────

export interface PlannedHireInput {
  /** A role ("Sales rep"), never a person's name (decision 7). 1-120 characters, trimmed. */
  label: string;
  costCentreId: string | null;
  /** 'YYYY-MM' */
  startMonth: string;
  /** 'YYYY-MM' or null (open-ended). */
  endMonth: string | null;
  fte: number;
}

export interface StoredPlannedHire extends PlannedHireInput {
  id: string;
  updatedAt: string;
}

const HIRE_COLUMNS = () => sql`
  id::text AS id, label, cost_centre_id::text AS cost_centre_id, to_char(start_month, 'YYYY-MM') AS start_month,
  to_char(end_month, 'YYYY-MM') AS end_month, fte::text AS fte, ${tokenSql()} AS token`;

const hireOf = (r: DbRow): StoredPlannedHire => ({
  id: String(r.id), label: String(r.label), costCentreId: id(r.cost_centre_id), startMonth: String(r.start_month),
  endMonth: month(r.end_month), fte: Number(r.fte), updatedAt: String(r.token),
});

export async function listPlannedHires(companyId: string, versionId: string): Promise<StoredPlannedHire[]> {
  const rows = (await sql`
    SELECT ${HIRE_COLUMNS()} FROM budget_planned_hires
     WHERE company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID
     ORDER BY start_month, label, id
  `) as DbRow[];
  return rows.map(hireOf);
}

export async function insertPlannedHire(companyId: string, versionId: string, userId: string, h: PlannedHireInput): Promise<StoredPlannedHire> {
  const rows = (await sql`
    INSERT INTO budget_planned_hires (company_id, version_id, label, cost_centre_id, start_month, end_month, fte, created_by)
    VALUES (${companyId}::UUID, ${versionId}::UUID, ${h.label}, ${h.costCentreId}::UUID, ${date(h.startMonth)}::DATE,
            ${date(h.endMonth)}::DATE, ${h.fte}::NUMERIC, ${userId})
    RETURNING ${HIRE_COLUMNS()}
  `) as DbRow[];
  return hireOf(rows[0]!);
}

/** Null when the version has no such hire. */
export async function updatePlannedHire(companyId: string, versionId: string, hireId: string, h: PlannedHireInput): Promise<StoredPlannedHire | null> {
  const rows = (await sql`
    UPDATE budget_planned_hires
       SET label = ${h.label}, cost_centre_id = ${h.costCentreId}::UUID, start_month = ${date(h.startMonth)}::DATE,
           end_month = ${date(h.endMonth)}::DATE, fte = ${h.fte}::NUMERIC
     WHERE id = ${hireId}::UUID AND company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID
    RETURNING ${HIRE_COLUMNS()}
  `) as DbRow[];
  return rows[0] ? hireOf(rows[0]) : null;
}

/** True when the hire existed. */
export async function deletePlannedHire(companyId: string, versionId: string, hireId: string): Promise<boolean> {
  const rows = (await sql`
    DELETE FROM budget_planned_hires
     WHERE id = ${hireId}::UUID AND company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID
    RETURNING id
  `) as DbRow[];
  return rows.length > 0;
}
