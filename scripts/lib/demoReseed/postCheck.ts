/**
 * runPostChecks: every Demo-scoped check (PLAN 7.2) plus the deploy's own 16
 * integrity checks (scripts/lib/integrityChecks*.ts, as verify-deploy.sh runs
 * them), read-only. Used after the seed inside the transaction, and on its own
 * by `--check-only`.
 *
 * The deploy checks are global (every company): the reseed fails only when one
 * is `fail` afterwards and was not before, or its offending count grew, so an
 * unrelated tenant's problem neither blocks the run nor is blamed on it.
 */

import { coreChecks } from '../integrityChecks';
import { tenantChecks } from '../integrityChecksTenant';
import type { CheckResult } from '../integrityTypes';
import type { Window } from './dates';
import type { Tx } from './db';
import { checkA, checkB, checkC1, checkJ } from './postCheckLedger';
import { checkN1, checkN2, checkN3, checkN4, checkN5 } from './postCheckNames';
import { checkD, checkF1, checkG, checkP, checkV1, infoR } from './postCheckOther';

export type ExtraCheck = (tx: Tx) => Promise<CheckResult>;

export async function deployChecks(tx: Tx): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const check of [...coreChecks, ...tenantChecks]) out.push(await check(tx.sql));
  return out;
}

/** The deploy checks that got worse between two runs (new fail, or more offending rows). */
export function regressions(before: CheckResult[], after: CheckResult[]): CheckResult[] {
  return after.filter((a) => {
    if (a.status !== 'fail') return false;
    const b = before.find((x) => x.label === a.label);
    return !b || b.status !== 'fail' || (a.offending ?? 0) > (b.offending ?? 0);
  });
}

export async function demoChecks(tx: Tx, companyId: string, win: Window): Promise<CheckResult[]> {
  return [
    await checkN1(tx, companyId), await checkN2(tx, companyId), await checkN3(tx, companyId),
    await checkN4(tx, companyId), await checkN5(tx, companyId),
    ...(await checkG(tx, companyId, win)),
    ...(await checkD(tx, companyId, win)),
    ...(await checkA(tx, companyId, win)),
    ...(await checkJ(tx, companyId)),
    ...(await checkB(tx, companyId, win)),
    ...(await checkP(tx, companyId, win)),
    await checkV1(tx, companyId), await checkC1(tx, companyId), await checkF1(tx, companyId),
    ...(await infoR(tx, companyId)),
  ];
}

export interface PostCheckReport {
  demo: CheckResult[];
  deploy: CheckResult[];
  /** Deploy checks that regressed against `before` (empty when no baseline was given). */
  regressed: CheckResult[];
  failed: boolean;
}

export async function runPostChecks(
  tx: Tx,
  opts: { companyId: string; win: Window; before?: CheckResult[]; extraChecks?: ExtraCheck[] },
): Promise<PostCheckReport> {
  const demo = await demoChecks(tx, opts.companyId, opts.win);
  for (const extra of opts.extraChecks ?? []) demo.push(await extra(tx));
  const deploy = await deployChecks(tx);
  const regressed = opts.before ? regressions(opts.before, deploy) : deploy.filter((d) => d.status === 'fail');
  return { demo, deploy, regressed, failed: demo.some((c) => c.status === 'fail') || regressed.length > 0 };
}
