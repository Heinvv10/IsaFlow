/**
 * Scenario resolution (P6 spec §4, §13.21), pure over an in-memory chain.
 *
 * A scenario stores sparse overrides of its `based_on_version_id`. Resolution
 * walks target → base until a version holding a FULL document (or a
 * non-scenario, whose missing document means "derived defaults"), then applies
 * the override layers root first, target last. Objects deep-merge; a `Prov`
 * value and every list (capex, loans.existing, loans.planned, shareIssues,
 * dividends) REPLACE whole — never element-merge. The merged result is
 * validated again.
 *
 * Refused with `AssumptionChainError`: a missing target or base, a base in
 * another company or fiscal year, a cycle, more than MAX_SCENARIO_DEPTH
 * override layers, overrides stored on a non-scenario.
 */
import type { z } from 'zod';
import { AssumptionChainError, AssumptionsDocError } from './errors';
import {
  StoredAssumptionsDocSchema, ThreeWayAssumptionsSchema, isFullDoc,
  type AssumptionOverrides, type StoredAssumptionsDoc, type ThreeWayAssumptions,
} from './assumptionsSchema';

export const MAX_SCENARIO_DEPTH = 5;

export interface ChainVersion {
  id: string;
  companyId: string;
  fiscalYear: number;
  kind: 'original' | 'reforecast' | 'scenario';
  basedOnVersionId: string | null;
  /** The stored document, already parsed (`parseStoredDoc`); null when the version has none. */
  doc: StoredAssumptionsDoc | null;
}

export interface ResolvedAssumptions {
  assumptions: ThreeWayAssumptions;
  /** Version ids walked, target first. */
  chain: string[];
}

function issues(err: z.ZodError): AssumptionsDocError {
  return new AssumptionsDocError(err.issues.map(i => ({ path: i.path.map(String).join('.'), message: i.message })));
}

/** Validate a stored document (full or overrides). Throws AssumptionsDocError. */
export function parseStoredDoc(raw: unknown): StoredAssumptionsDoc {
  const r = StoredAssumptionsDocSchema.safeParse(raw);
  if (!r.success) throw issues(r.error);
  return r.data;
}

/** Validate a full document. Throws AssumptionsDocError. */
export function parseAssumptions(raw: unknown): ThreeWayAssumptions {
  const r = ThreeWayAssumptionsSchema.safeParse(raw);
  if (!r.success) throw issues(r.error);
  return r.data;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isProv(v: Record<string, unknown>): boolean {
  return 'value' in v && 'source' in v;
}

/** Keys that could reach an object's prototype: refused here, not left to a later parse. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** The assumptions document nests at most a few levels; anything deeper is refused, not recursed. */
const MAX_OVERRIDE_DEPTH = 8;

function refuseForbiddenKeys(v: unknown, path: string, depth = 0): void {
  if (!isPlainObject(v)) return;
  if (depth > MAX_OVERRIDE_DEPTH) throw new AssumptionsDocError([{ path, message: 'Nested too deeply' }]);
  for (const k of Object.keys(v)) {
    const at = path ? `${path}.${k}` : k;
    if (FORBIDDEN_KEYS.has(k)) throw new AssumptionsDocError([{ path: at, message: 'Forbidden key' }]);
    refuseForbiddenKeys(v[k], at, depth + 1);
  }
}

function mergeValue(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (!isPlainObject(over) || !isPlainObject(base) || isProv(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = mergeValue(base[k], v);
  return out;
}

/** One override layer over a full document; the result is validated. */
export function mergeOverrides(base: ThreeWayAssumptions, overrides: AssumptionOverrides): ThreeWayAssumptions {
  refuseForbiddenKeys(overrides, '');
  return parseAssumptions(mergeValue(base, overrides));
}

/**
 * Resolve `targetId`'s assumptions. `derived` is the derive service's document
 * for the company (used when the root holds no document).
 */
export function resolveAssumptions(
  targetId: string,
  versions: ReadonlyMap<string, ChainVersion>,
  derived: ThreeWayAssumptions,
): ResolvedAssumptions {
  const path: string[] = [];
  const layers: AssumptionOverrides[] = [];
  let cur = versions.get(targetId);
  if (!cur) throw new AssumptionChainError('VERSION_NOT_FOUND', `Version ${targetId} not found`, [targetId]);
  let root: ThreeWayAssumptions;
  for (;;) {
    if (path.includes(cur.id)) throw new AssumptionChainError('CYCLE', 'Scenario chain loops back on itself', [...path, cur.id]);
    path.push(cur.id);
    const doc = cur.doc;
    if (doc && isFullDoc(doc)) { root = doc; break; }
    if (cur.kind !== 'scenario') {
      if (doc) throw new AssumptionChainError('OVERRIDES_ON_NON_SCENARIO', `Version ${cur.id} is not a scenario but stores overrides`, path);
      root = derived;
      break;
    }
    if (cur.basedOnVersionId === null) {
      if (doc) throw new AssumptionChainError('BASE_MISSING', `Scenario ${cur.id} stores overrides but has no base`, path);
      root = derived;
      break;
    }
    layers.push(doc ? doc.overrides : {});
    if (layers.length > MAX_SCENARIO_DEPTH) {
      throw new AssumptionChainError('TOO_DEEP', `Scenario chain deeper than ${MAX_SCENARIO_DEPTH}`, path);
    }
    const base = versions.get(cur.basedOnVersionId);
    if (!base) throw new AssumptionChainError('BASE_MISSING', `Base version ${cur.basedOnVersionId} not found`, [...path, cur.basedOnVersionId]);
    if (base.companyId !== cur.companyId) throw new AssumptionChainError('CROSS_COMPANY', 'Base version belongs to another company', [...path, base.id]);
    if (base.fiscalYear !== cur.fiscalYear) throw new AssumptionChainError('CROSS_YEAR', 'Base version is in another fiscal year', [...path, base.id]);
    cur = base;
  }
  let resolved = root;
  for (let i = layers.length - 1; i >= 0; i--) resolved = mergeOverrides(resolved, layers[i] as AssumptionOverrides);
  return { assumptions: resolved, chain: path };
}
