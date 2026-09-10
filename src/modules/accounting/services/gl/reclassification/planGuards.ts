/**
 * The request-level refusals, and the account read they need.
 *
 * A REFUSAL IS ABOUT THE REQUEST — the agent has to change what it sent — so
 * every one of these runs BEFORE a single candidate line is read, and the tool
 * renders them as a pre-write `toolError` with the idempotency key left free.
 * They live apart from `plan.ts` because that file is at the 300-line ceiling
 * and because this is the narrower question: is this move admissible at all,
 * before anything about the DATA is consulted.
 */

import { withSavepoint } from '@/lib/neon';
import { getAccountById } from '../chartOfAccountsService';
import { isReportVisibleLeaf, isSubjectToLeafRule } from '../isReportVisibleLeaf';
import { lockGlAccountsForUpdate } from '../glAccountLock';
import { getPeriodStatusForDate } from '../periodStatusService';
import { isVatPeriodLocked } from '../../reports/vatPeriodLockService';
import type { AccountType } from '../accountClassification';

export interface ReclassAccount {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  isActive: boolean;
  level: number;
}

/** A fault in the REQUEST. The caller returns it as a pre-write toolError. */
export interface ReclassRefusal {
  refused: string;
}

/**
 * The subtypes `vatReturnService` uses to decide VAT201 membership.
 *
 * A line on one of these accounts is ON the return, and a line on one of them
 * with a NULL `vat_type` is swept into **box 15 at full value**. This tool can
 * move arbitrary posted lines, so a move onto such an account rewrites a
 * statutory return as a side effect of a housekeeping operation. That is
 * refused outright rather than warned about: a warning an agent can ignore is
 * not a control on a SARS submission.
 *
 * `'tax'` is in the set even though FINDINGS B37 records that it is NOT VAT —
 * Brightsphere's PAYE account carries it — precisely because `vatReturnService`
 * treats it as VAT today. The set mirrors what the return actually reads, not
 * what it ought to read; narrowing it here would silently re-open the hole
 * while that defect stands.
 */
const VAT_RETURN_SUBTYPES = new Set(['vat_input', 'vat_output', 'tax']);

async function loadAccount(
  companyId: string,
  id: string,
): Promise<ReclassAccount | null> {
  const account = await getAccountById(companyId, id);
  if (!account) return null;
  return {
    id: account.id,
    code: account.accountCode,
    name: account.accountName,
    type: account.accountType as AccountType,
    subtype: account.accountSubtype ?? null,
    isActive: account.isActive,
    // `gl_accounts.level` is nullable with a default of 1, and
    // `chartOfAccountsService.mapRow` maps it with a bare `Number()` — so a NULL
    // row arrives here as 0, not as null, and `?? 1` never fires. `|| 1` is what
    // actually restores the column default, and it keeps the refusal below
    // reading "level 1" instead of a level the chart does not use.
    level: Number(account.level) || 1,
  };
}

export interface GuardInput {
  companyId: string;
  sourceAccountId: string;
  targetAccountId: string;
  from: string | null;
  to: string | null;
  postingDate: string | null;
  /**
   * TRUE only on the path that is about to WRITE, and the same flag that
   * decides the candidate-line lock in `plan.ts` — so the two locks this
   * request takes are taken together or not at all. A preview must not hold
   * `FOR UPDATE` on the target for its duration: it would block every real
   * batch and every `merge_gl_accounts` naming that account, to protect a
   * verdict nothing is about to act on.
   */
  lockCandidateLines: boolean;
}

export interface AdmissibleMove {
  source: ReclassAccount;
  target: ReclassAccount;
}

export function isRefusal<T>(x: T | ReclassRefusal): x is ReclassRefusal {
  return typeof x === 'object' && x !== null && 'refused' in x;
}

/** Both accounts, or the reason this move may not proceed at all. */
export async function admitReclassification(
  input: GuardInput,
): Promise<AdmissibleMove | ReclassRefusal> {
  const { companyId } = input;
  if (input.sourceAccountId === input.targetAccountId) {
    return { refused: 'source_account_id and target_account_id must differ.' };
  }
  if (input.from !== null && input.to !== null && input.to < input.from) {
    return { refused: 'to must not precede from.' };
  }

  // Ownership, from a READ, with the shared NOT_FOUND text supplied by the
  // caller: a cross-tenant id must read identically to a typo'd one.
  const source = await loadAccount(companyId, input.sourceAccountId);
  if (!source) return { refused: 'NOT_FOUND' };
  const target = await loadAccount(companyId, input.targetAccountId);
  if (!target) return { refused: 'NOT_FOUND' };

  // A deactivated account refuses every posting (`assertNoInactiveAccountLines`),
  // so EVERY journal in the batch would fail. That is a fault in the request —
  // refused here, before anything is written, rather than discovered on line 1
  // of 419 with a generic failure.
  if (!source.isActive) {
    return {
      refused:
        `Source account ${source.code} is deactivated, so the contra leg cannot post. ` +
        'Reactivate it for the duration of the reclassification.',
    };
  }
  if (!target.isActive) {
    return {
      refused:
        `Target account ${target.code} is deactivated and cannot receive a posting. ` +
        'Reactivate it, or choose another target.',
    };
  }

  // The posting date's OWN period, validated before any candidate is read. Both
  // states get their own message because the remedies differ: create the fiscal
  // year, versus re-open the period.
  if (input.postingDate !== null) {
    const status = await getPeriodStatusForDate(companyId, input.postingDate);
    if (status === 'no_period') {
      return {
        refused:
          `No fiscal period covers posting_date ${input.postingDate}. Create the fiscal ` +
          'year first — a journal outside every period is invisible to the trial ' +
          'balance, the VAT201 and the AFS.',
      };
    }
    if (status !== 'open') {
      return { refused: `The fiscal period covering posting_date ${input.postingDate} is closed.` };
    }
  }

  for (const account of [source, target]) {
    if (account.subtype !== null && VAT_RETURN_SUBTYPES.has(account.subtype)) {
      return {
        refused:
          `${account.code} ${account.name} is a VAT control account (subtype ` +
          `${account.subtype}), and the VAT201 is built from the lines sitting on ` +
          'those accounts. Moving lines on or off one rewrites a statutory return, ' +
          'and a line landing there with no vat_type is swept into box 15 at full ' +
          'value. Reclassify VAT control accounts through the VAT tools, not this one.',
      };
    }
  }

  // A line that CARRIES VAT coding and sits in a filed period is anchored to a
  // return already sent to SARS. Per line, so one such line never costs the
  // rest of the batch; refused up front only for a posting_date, where the
  // whole batch would land in the locked period.
  if (input.postingDate !== null && (await isVatPeriodLocked(companyId, input.postingDate))) {
    return {
      refused:
        `posting_date ${input.postingDate} falls inside a filed VAT period. Choose a ` +
        'date outside it, or omit posting_date so each journal is dated at its own ' +
        'source line.',
    };
  }

  // A level 1 or 2 asset, liability or equity account that has children is a
  // HEADER: the balance sheet and the trend report select an account only when
  // `level >= 3 OR it has no children`, so every rand moved onto one leaves
  // both reports while the trial balance still foots. Refused rather than
  // warned about, for the same reason as the VAT control accounts below — the
  // caller supplies the target id and has no other signal that the account is
  // unreachable. Revenue and expense targets are exempt: the income statement
  // has no level filter, so nothing disappears there (`isReportVisibleLeaf`).
  //
  // Locked before it is asked, and only on the WRITE path and only for the
  // targets the rule can bite, so the verdict still holds when the lines are
  // written. Unlike `mergeAccounts`, this path never locks the account:
  // `lockReclassLinesForUpdate` takes the journal LINES, and the write itself
  // (`UPDATE gl_journal_lines SET gl_account_id = target`) takes only FOR KEY
  // SHARE on the target through `gl_accounts_parent_account_id_fkey` — which
  // does not conflict with the FOR KEY SHARE a concurrent `createAccount`
  // needs. So without this the window is real on the write path.
  //
  // A preview takes no lock, for the same reason it locks no candidate lines:
  // it can be overtaken by a batch that commits before it, exactly as a report
  // can, and that is cheaper than blocking every real batch on the account.
  // `assertParentUsable` takes the mirror lock on its own path, so the create
  // that would race a real batch is ordered against it from both sides.
  //
  // LAST of the refusals, deliberately. A caller that locks and then refuses
  // holds the row for the rest of the request transaction, so every refusal
  // that needs no lock — closed period, VAT control account, filed VAT period —
  // is answered ABOVE, and a request that was never going to proceed blocks
  // nobody. `merge_gl_accounts` makes the opposite trade knowingly
  // (`glAccountLock.ts`) because its preview must read under the lock; here
  // there is nothing to buy.
  //
  // IN ITS OWN SAVEPOINT, for the same reason as the line lock in `plan.ts`:
  // a `lock_timeout` raises 55P03 and ABORTS the subtransaction, `planFromArgs`
  // catches `GL_ACCOUNT_LOCK_TIMEOUT` and RETURNS a toolError, and the
  // registry's enclosing `RELEASE SAVEPOINT` then raises 25P02 — handing the
  // agent GENERIC_FAILURE and discarding the wording the catch exists to
  // preserve. Catching a SQL error does not un-poison a transaction; only a
  // savepoint rollback does.
  if (input.lockCandidateLines && isSubjectToLeafRule(target.level, target.type)) {
    await withSavepoint(
      'reclass_target_lock',
      () => lockGlAccountsForUpdate(companyId, [target.id]),
    );
  }
  if (!(await isReportVisibleLeaf(companyId, target.id, target.level, target.type))) {
    return {
      refused:
        `${target.code} ${target.name} is a header account (level ${target.level} with ` +
        'children), and the balance sheet and trend report omit it. Lines moved there would ' +
        'disappear from both while the trial balance still foots. Choose one of its ' +
        'children, or another leaf account.',
    };
  }

  return { source, target };
}
