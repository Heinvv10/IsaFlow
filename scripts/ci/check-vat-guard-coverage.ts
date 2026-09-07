/**
 * Fail the build when a file decides a VAT claim without going through a guard.
 *
 * The rule lives in `vatGuardRules.ts` and is unit-tested; this file walks the
 * tree, applies the allowlist, and reports. Read that module for why the
 * pattern is a defect and why imports — not mentions — are what satisfy it.
 *
 * FAILS CLOSED, like its siblings: it asserts it scanned a plausible number of
 * files and exits non-zero if it did not, so a broken walk cannot report PASS.
 * It also fails on a STALE allowlist entry — a path that no longer exists, or
 * one that has since started importing a guard — because an allowlist nobody
 * prunes is how a gate quietly stops gating.
 *
 * Run: bun scripts/ci/check-vat-guard-coverage.ts
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inspectVatGuardCoverage } from './vatGuardRules';

const ROOT = join(import.meta.dir ?? __dirname, '..', '..');
const SCAN_DIRS = ['src', 'pages'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage', '.git']);
const MIN_FILES_EXPECTED = 200;

/**
 * Paths that decide or forward a VAT claim and are ALLOWED not to guard.
 *
 * Every entry carries the reason, because the reason is the only thing that
 * makes this list different from a list of exemptions. Two shapes qualify:
 *
 *   ATTENDED — a human (or an agent acting on one specific document they are
 *   looking at) chose this code and was shown the warning. Coercing here would
 *   silently override a considered decision, which is the failure the whole
 *   warn/coerce split exists to avoid.
 *
 *   NO CLAIM DECIDED — the file reports on, settles, or forwards a claim that
 *   something else already resolved. It picks no account.
 *
 * Adding an entry means arguing one of those two. If neither fits, the file
 * needs the guard, not a line here.
 */
const ALLOWED: Record<string, string> = {
  // ── ATTENDED ──────────────────────────────────────────────────────────────
  'src/modules/accounting/services/bank/bankAllocationService.ts':
    'THE attended path. The bank screen shows the s17(2)(a) and non-supply '
    + 'warnings and the user\'s choice stands. Its unattended callers guard '
    + 'BEFORE calling it; moving a coercion in here would turn every attended '
    + 'override into a no-op.',
  'src/modules/accounting/services/ap/supplierInvoiceWorkflowService.ts':
    'Attended: someone approves one specific invoice, and the tax amount comes '
    + 'from the captured document rather than being predicted. KNOWN GAP — no '
    + 'supplier-invoice screen shows the warning the bank screens do, so the '
    + '"attended" claim is weaker here than elsewhere. Tracked separately.',
  'pages/api/accounting/bank-match-confirm.ts':
    'Attended API action on one transaction the user is looking at.',
  'pages/api/accounting/bank-transactions-action.ts':
    'Attended API action on one transaction the user is looking at.',
  'pages/api/accounting/bank-transactions-manual.ts':
    'Attended API action on one transaction the user is looking at.',

  // ── NO CLAIM DECIDED ──────────────────────────────────────────────────────
  'src/modules/accounting/services/bank/bankRulesMatchingHelpers.ts':
    'Builds the journal line from whatever code its already-guarded caller '
    + 'resolved. Decides nothing itself.',
  'src/modules/accounting/services/reports/drcVatService.ts':
    'Reports on already-posted balances. Chooses no account\'s claim.',
  'src/modules/accounting/services/reports/vat201ReportService.ts':
    'Reports on already-posted balances. Chooses no account\'s claim.',
  'src/modules/accounting/services/reports/vatBoxBasis.ts':
    'Derives VAT201 box totals from posted journals. Chooses no claim.',
  'src/modules/accounting/services/ap/supplierBankPaymentService.ts':
    'allocType supplier — VAT routes to the AP control account, never a '
    + 'user-chosen GL account, so no guard could fire by construction.',
  'src/modules/accounting/services/ar/receiptMatchConfirmService.ts':
    'allocType customer — VAT routes to the AR control account. Same reason.',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    // `.ts` only, deliberately. A `.tsx` page cannot post a journal — it calls
    // an API, which calls a service, and the service is what this gate governs.
    // Scanning components adds form defaults like `vatType: 'standard'` on a
    // blank credit-note line, which are not claims anyone posted; allowlisting
    // those would pad the list with entries that are not really exemptions.
    else if (/\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

const files: string[] = [];
for (const dir of SCAN_DIRS) {
  const full = join(ROOT, dir);
  if (existsSync(full)) walk(full, files);
}

if (files.length < MIN_FILES_EXPECTED) {
  console.error(
    `[vat-guard] scanned only ${files.length} files (expected >= ${MIN_FILES_EXPECTED}).`
    + ' The walk is broken — refusing to report a pass.',
  );
  process.exit(1);
}

const unguarded: Array<{ rel: string; kinds: string[] }> = [];
const seenAllowed = new Set<string>();
const nowGuarded: string[] = [];

for (const file of files) {
  const rel = file.slice(ROOT.length + 1);
  const finding = inspectVatGuardCoverage(readFileSync(file, 'utf8'));
  if (!finding) continue;
  const allowed = rel in ALLOWED;
  if (allowed) {
    seenAllowed.add(rel);
    // An allowlisted file that has since started guarding no longer needs the
    // exemption. Reported so the list shrinks instead of ossifying.
    if (finding.guarded) nowGuarded.push(rel);
    continue;
  }
  if (!finding.guarded) unguarded.push({ rel, kinds: finding.kinds });
}

const stale = Object.keys(ALLOWED).filter((rel) => !seenAllowed.has(rel));
let failed = false;

if (unguarded.length > 0) {
  failed = true;
  console.error('[vat-guard] These decide or forward a VAT claim without a guard:\n');
  for (const { rel, kinds } of unguarded) {
    console.error(`  ${rel}\n    matched: ${kinds.join(', ')}`);
  }
  console.error(
    '\n  Route it through gl/ruleVatResolution (or the denial funnel), or add it'
    + '\n  to ALLOWED in this file WITH the reason it is attended or decides no'
    + '\n  claim. Four unattended posters reached production one at a time; this'
    + '\n  gate exists so the fifth does not.\n',
  );
}

if (stale.length > 0) {
  failed = true;
  console.error('[vat-guard] Allowlisted paths that no longer match the rule:\n');
  for (const rel of stale) console.error(`  ${rel}`);
  console.error('\n  Deleted, renamed, or no longer doing VAT work — remove the entry.\n');
}

if (nowGuarded.length > 0) {
  failed = true;
  console.error('[vat-guard] Allowlisted paths that now import a guard:\n');
  for (const rel of nowGuarded) console.error(`  ${rel}`);
  console.error('\n  They no longer need the exemption — remove the entry.\n');
}

if (failed) process.exit(1);
console.log(
  `[vat-guard] OK — ${files.length} files scanned, `
  + `${Object.keys(ALLOWED).length} attended/no-claim paths allowlisted.`,
);
