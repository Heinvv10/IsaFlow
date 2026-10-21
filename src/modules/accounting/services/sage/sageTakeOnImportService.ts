/**
 * Runs a reviewed Sage pull through the migration wizard's own take-on steps,
 * in the wizard's order, inside the request's one transaction (`withAuth`):
 *
 *   chart of accounts + role map → customers → suppliers →
 *   opening trial balance (+ clearing line on Opening Balance Equity) →
 *   outstanding customer documents → outstanding supplier documents →
 *   validation → session complete.
 *
 * Nothing here posts a journal of its own; every write is a wizard step that
 * is already covered by its own tests and audit fixes (take-on documents post
 * no VAT, re-runs reverse their own opening entry, …). If any step throws, the
 * whole import rolls back.
 *
 * The take-on is rebuilt from the stored pull against the chart as it stands
 * NOW, not as it stood at review, so codes cannot collide with accounts added
 * in between.
 *
 * One take-on per company. The migration import lock is taken FIRST, before
 * anything is read, and a company that already has an imported Sage pull or a
 * standing opening-balance entry is refused: each import is its own migration
 * session and an opening-balance re-run only reverses its own session's entry,
 * so a second import would double the opening trial balance.
 *
 * Contacts are matched by exact name on this path (sageTakeOnContactIds): a
 * Sage name is Sage's own, and the wizard's near-spelling match could land a
 * Sage invoice on a different existing customer.
 */
import { log } from '@/lib/logger';
import { importChartOfAccounts } from '../core/migrationCoaService';
import { importCustomers, importSuppliers } from '../core/migrationContactService';
import { lockMigrationImport } from '../core/migrationPostingSupport';
import { importARInvoices, importOpeningBalances } from '../core/migrationImportService';
import { importAPInvoices } from '../ap/migrationApService';
import { completeSession, createSession, type ImportResult, type MigrationError } from '../core/migrationService';
import { validateMigration, type ValidationResult } from '../core/migrationValidationService';
import { ensureOpeningBalanceEquityAccount } from '../gl/openingBalanceEquityService';
import { buildSageTakeOn } from './sageTakeOnBuilder';
import { exactContactIds } from './sageTakeOnContactIds';
import { pullSizeRefusal, sizesOf } from './sagePullLimits';
import { findPriorTakeOn, readTakeOnContext } from './sageTakeOnContext';
import { loadPullForImport, markImported, READY_TTL_HOURS, type StoredPull } from './sageTakeOnStore';
import { summarise, type TakeOnIssue, type TakeOnSummary } from './sageTakeOnTypes';

export class SageImportRefused extends Error {
  constructor(message: string, public readonly issues: TakeOnIssue[] = []) {
    super(message);
    this.name = 'SageImportRefused';
  }
}

type StepResult = Pick<ImportResult, 'imported' | 'skipped'> & { errors: MigrationError[] };

export interface SageImportOutcome {
  sessionId: string;
  summary: TakeOnSummary;
  steps: {
    accounts: StepResult;
    customers: StepResult;
    suppliers: StepResult;
    openingBalances: { journalEntryId: string; errors: MigrationError[] } | null;
    arInvoices: StepResult;
    apInvoices: StepResult;
  };
  validation: ValidationResult[];
  issues: TakeOnIssue[];
}

const step = (r: ImportResult): StepResult => ({ imported: r.imported, skipped: r.skipped, errors: r.errors });

const AREA: Record<string, TakeOnIssue['area']> = {
  accounts: 'accounts', customers: 'customers', suppliers: 'suppliers', arInvoices: 'receivables', apInvoices: 'payables',
};

/** Every row a step refused (warnings excluded), as review-screen issues. */
function rowFailures(steps: Record<keyof typeof AREA, StepResult>, opening: MigrationError[]): TakeOnIssue[] {
  const hard = (e: MigrationError) => e.severity !== 'warning';
  const out: TakeOnIssue[] = opening.filter(hard).map((e) => ({ severity: 'error', area: 'trial_balance', message: e.message }));
  for (const [key, result] of Object.entries(steps)) {
    for (const e of result.errors.filter(hard)) out.push({ severity: 'error', area: AREA[key]!, message: e.message });
  }
  return out;
}

const NOT_READY: Partial<Record<StoredPull['status'], string>> = {
  pulling: 'IsaFlow is still reading this company from Sage. Wait for the review, then import.',
  failed: 'Reading from Sage did not finish, so there is nothing to import. Start again from "Import from Sage".',
  imported: 'This Sage review has already been imported.',
  expired: `This Sage review is more than ${READY_TTL_HOURS} hours old and its data has been cleared. Start again from "Import from Sage" to read Sage as it is now.`,
};

/** The pull, refused unless it is a 'ready' review inside its TTL. */
function readyPull(stored: StoredPull | null): NonNullable<StoredPull['pull']> {
  if (!stored) throw new SageImportRefused('That Sage review was not found. Start again from "Import from Sage".');
  if (stored.status === 'ready' && stored.expired) throw new SageImportRefused(NOT_READY.expired!);
  if (stored.status !== 'ready' || !stored.pull) {
    throw new SageImportRefused(NOT_READY[stored.status] ?? 'This Sage review was discarded. Start again from "Import from Sage".');
  }
  return stored.pull;
}

export async function importSagePull(companyId: string, userId: string, pullId: string): Promise<SageImportOutcome> {
  // Before any read: the prior-take-on check below is a read-then-write, and
  // every wizard step takes this same lock (re-entrant, transaction-scoped).
  await lockMigrationImport(companyId);
  const pull = readyPull(await loadPullForImport(companyId, pullId));
  // The caps again: a review read under older (larger) caps must not run past the request's time.
  const tooBig = pullSizeRefusal(sizesOf(pull));
  if (tooBig) throw new SageImportRefused(tooBig);
  const prior = await findPriorTakeOn(companyId);
  if (prior) throw new SageImportRefused(prior);

  const takeOn = buildSageTakeOn(pull, await readTakeOnContext(companyId, pull.asAtDate));
  const blocking = takeOn.issues.filter((i) => i.severity === 'error');
  if (blocking.length > 0) {
    throw new SageImportRefused('Some of the Sage data cannot be imported yet. Each item below says what to fix and where; then review again.', blocking);
  }

  const session = await createSession(companyId, 'sage_cloud', userId);
  log.info('Sage take-on starting', { companyId, pullId, sessionId: session.id, sageCompanyId: takeOn.sageCompany.id }, 'migration');

  const accounts = step(await importChartOfAccounts(companyId, session.id, takeOn.accounts, takeOn.systemAccountMap));
  if (accounts.imported === 0) {
    throw new SageImportRefused(`The chart of accounts could not be imported: ${accounts.errors.map((e) => e.message).join('; ') || 'no accounts were accepted'}.`);
  }
  const customers = step(await importCustomers(companyId, session.id, takeOn.customers, 'skip', 'exact'));
  const suppliers = step(await importSuppliers(companyId, session.id, takeOn.suppliers, 'skip', userId, 'exact'));

  // Every document onto the contact of exactly its name (M5), as the page's
  // manual pick would: the wizard steps honour an id only if it is this
  // company's. A name with no exact contact refuses below with the rest.
  const ids = await exactContactIds(companyId, takeOn.arInvoices.map((i) => i.customerName), takeOn.apInvoices.map((i) => i.supplierName));
  const arRows = takeOn.arInvoices.map((i) => ({ ...i, customerId: ids.customers.get(i.customerName) ?? '' }));
  const apRows = takeOn.apInvoices.map((i) => ({ ...i, supplierId: ids.suppliers.get(i.supplierName) ?? '' }));

  let openingBalances: SageImportOutcome['steps']['openingBalances'] = null;
  const clearing = takeOn.openingBalanceClearing;
  const lines = [...takeOn.openingBalances];
  if (clearing.debit > 0 || clearing.credit > 0) {
    const obe = await ensureOpeningBalanceEquityAccount(companyId);
    lines.push({ accountCode: obe.accountCode, debit: clearing.debit, credit: clearing.credit });
  }
  if (lines.length > 0) {
    openingBalances = await importOpeningBalances(companyId, session.id, takeOn.asAtDate, lines, userId);
  }

  // The document steps take documents on against Opening Balance Equity; make
  // sure it exists even when the trial balance needed no clearing line.
  if (takeOn.arInvoices.length > 0 || takeOn.apInvoices.length > 0) await ensureOpeningBalanceEquityAccount(companyId);
  const arInvoices = arRows.length > 0
    ? step(await importARInvoices(companyId, session.id, arRows, userId))
    : { imported: 0, skipped: 0, errors: [] };
  const apInvoices = apRows.length > 0
    ? step(await importAPInvoices(companyId, session.id, apRows, userId))
    : { imported: 0, skipped: 0, errors: [] };

  // All or nothing. The wizard reports a row it could not take on as a result,
  // not a throw, which suits a file the operator fixes and re-uploads; a
  // one-click Sage import that half-landed would leave the books short with
  // no file to fix. Throwing here rolls the whole import back (the route runs
  // it in a savepoint) and lists every row that failed.
  const failed = [
    ...ids.issues,
    ...rowFailures({ accounts, customers, suppliers, arInvoices, apInvoices }, openingBalances?.errors ?? []),
  ];
  if (failed.length > 0) {
    throw new SageImportRefused('IsaFlow could not take on every item, so nothing was imported. Fix these, then review again.', failed);
  }

  const validation = await validateMigration(companyId, session.id);
  await completeSession(session.id, companyId);

  const summary = summarise(takeOn);
  await markImported(companyId, pullId, session.id, summary);
  log.info('Sage take-on complete', {
    companyId, sessionId: session.id,
    accounts: accounts.imported, customers: customers.imported, suppliers: suppliers.imported,
    arInvoices: arInvoices.imported, apInvoices: apInvoices.imported,
  }, 'migration');

  return {
    sessionId: session.id,
    summary,
    steps: { accounts, customers, suppliers, openingBalances, arInvoices, apInvoices },
    validation,
    issues: takeOn.issues,
  };
}
