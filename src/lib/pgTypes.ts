/**
 * Process-wide pg type-parser overrides.
 *
 * WHY THIS IS ITS OWN MODULE: `pg.types` is a singleton on the `pg` module, so
 * one call here configures every Pool in the process — but only once this
 * module has actually been imported. This repo builds ten separate pools
 * (src/lib/neon.ts plus the auth/admin/invite/extension pools), and a request
 * served entirely by a route that never pulled in neon.ts would otherwise get
 * the default parsers. Importing this module for its side effect from each
 * pool-constructing file removes that import-order dependency.
 *
 * Idempotent: setTypeParser just overwrites the entry, so repeat imports and
 * repeat calls are both harmless.
 */
import pg from 'pg';

// DATE (OID 1082) → plain 'YYYY-MM-DD' string, not a JS Date.
//
// pg's default parser builds a Date at LOCAL midnight. This app runs in SAST
// (UTC+2), so any `.toISOString()` on that value converts to UTC first and
// lands on the PREVIOUS day: '2026-08-28'::date read back as '2026-08-27'.
//
// That reached the ledger, not just the UI. bankRuleAutoPostLine and
// provisionalPostingService derived a journal's entry_date from
// bank_transactions.transaction_date this way, so a transaction on the 1st of
// a month posted into the previous month — a different VAT period — and
// bankRuleAutoPostLine's own open-period pre-check ran against that same
// shifted date.
//
// A DATE carries no time and no zone, so a string is the honest
// representation: it cannot be shifted by an offset it never had. Only 1082 is
// overridden — TIMESTAMP (1114) and TIMESTAMPTZ (1184) are genuine instants
// and keep their Date parsing.
//
// `fmtDate()` in src/lib/neon.ts accepts both shapes, so call sites that
// already route through it are correct either way.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
