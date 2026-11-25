/** Migration 1032's text for the backfill re-run suites: the whole file, and the file without its final call (the definition only). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MIGRATION = readFileSync(join(process.cwd(), 'scripts/migrations/sql/1032_purchase_order_bill_links_backfill_rerun.sql'), 'utf8');
export const INSTALL = MIGRATION.replace(/\nSELECT public\.purchase_order_bill_links_backfill\(\);\s*$/, '\n');
