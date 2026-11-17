/**
 * Migration prefix rule: the static half of the pre-deploy parity gate
 * (scripts/lib/migrationParity.ts), run on every PR so a clash shows on the PR
 * instead of aborting a production deploy. The 14 Nov 2026 07:24 deploy stopped
 * on DUPLICATE_PENDING_VERSION: two PRs each added a 990_ migration and both
 * merged green (issue #1380).
 *
 * A file's version is what the runner records (`parseVersionFromFilename`:
 * digits plus up to two letters), so 244_, 244b_ and 999za_ are different versions,
 * as the repo's CLAUDE.md allows. Any digit count is accepted: the prefix after
 * 999_ is 1000_, which the runner orders numerically (compareMigrations).
 *
 * A file clashes when it shares its version with another repo file
 * (DUPLICATE_PENDING_VERSION at deploy) or with a migration tracked on prod
 * whose file has left the repo (PENDING_VERSION_TAKEN).
 * A filename the runner cannot parse fails too: the runner throws on it.
 *
 * On a PR the checkout is GitHub's merge of the PR into master, so a prefix
 * that master took since the branch was cut clashes here too, and the merge
 * queue re-runs this on top of master before it merges.
 */
import { parseVersionFromFilename } from '../lib/migrationFiles';
import { HISTORIC_PROD_ORPHANS } from '../lib/migrationParity';

/**
 * Every repo file that clashed when this gate became blocking (2026-11-14).
 * All are applied on prod and cannot be renamed (the runner tracks by name).
 * Frozen: never add a name here to pass the gate; rename the new file instead.
 */
export const HISTORIC_PREFIX_CLASHES: ReadonlySet<string> = new Set([
  // Two repo files share a version.
  '341_payroll_sars_codes.sql',
  '341_portal_contacts.sql',
  '342_payroll_medical_aid_deps.sql',
  '342_portal_magic_links.sql',
  '343_afs_signum_columns.sql',
  '343_payroll_eti.sql',
  '344_afs_section_comments_author_type.sql',
  '344_payroll_audit_log.sql',
  '434_analytics_utm.sql',
  '434_customer_dunning_overrides.sql',
  '436_bureaus.sql',
  '436_sent_mirror_connections.sql',
  '437_payg_flow_wallet.sql',
  '437_payroll_recurring_components.sql',
  // Shares a version with a HISTORIC_PROD_ORPHANS row (both tracked on prod).
  '245_company_settings.sql',
  '246_customer_supplier_fields.sql',
  '250_leave_management.sql',
  '251_demo_seed_data.sql',
  '255_fix_missing_schema.sql',
  '265_admin_platform_announcements.sql',
  '266_account_lockout.sql',
  '292_composite_indexes_batch2.sql',
  '300_portal_invoice_token.sql',
  '347_auto_posting_foundation.sql',
  '397_grants_and_rls_fixes.sql',
  '431_ar_dunning_templates.sql',
]);

export interface PrefixClash {
  name: string;
  detail: string;
}

function versionOf(name: string): string | null {
  try {
    return parseVersionFromFilename(name);
  } catch {
    return null; // reported by the caller as an unparseable filename
  }
}

/** Clashes among `names` (bare *.sql filenames), ignoring the frozen historic ones. */
export function findPrefixClashes(
  names: readonly string[],
  historic: ReadonlySet<string> = HISTORIC_PREFIX_CLASHES,
  prodOrphans: ReadonlySet<string> = HISTORIC_PROD_ORPHANS,
): PrefixClash[] {
  const byVersion = new Map<string, string[]>();
  const clashes: PrefixClash[] = [];
  for (const name of names) {
    const version = versionOf(name);
    if (version === null) {
      clashes.push({ name, detail: 'no NNN_ prefix: the migration runner refuses this filename' });
      continue;
    }
    byVersion.set(version, [...(byVersion.get(version) ?? []), name]);
  }
  const orphanByVersion = new Map<string, string>();
  for (const orphan of prodOrphans) {
    const version = versionOf(orphan);
    if (version !== null) orphanByVersion.set(version, orphan);
  }

  for (const [version, group] of byVersion) {
    for (const name of group) {
      if (historic.has(name)) continue;
      const others = group.filter((n) => n !== name);
      if (others.length > 0) {
        clashes.push({ name, detail: `version ${version} is also used by ${others.join(', ')}` });
      }
      const orphan = orphanByVersion.get(version);
      if (orphan !== undefined) {
        clashes.push({ name, detail: `version ${version} is already tracked on prod by ${orphan} (no repo file)` });
      }
    }
  }
  return clashes;
}
