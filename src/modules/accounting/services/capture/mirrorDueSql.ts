/**
 * The cron's due selection for both mirrors (S-07e part B). Per company, only its most overdue
 * due connection is a candidate, so one tenant's many connections cannot fill the tick (the cron
 * is serial; mirrorLimits.ts). Of the candidates, oldest first: never scanned, then the longest
 * waiting; a last_scan_at in the future (only migration_admin can write one) is due and sorts
 * last. A stored interval below the minimum counts as the minimum. SKIP LOCKED passes over a row
 * another migration_admin write holds (it does not exclude overlapping ticks: the in-process
 * claimScan does); NO KEY UPDATE does not wait for the key-share lock an app role's scan-log
 * INSERT takes.
 */
import { MIN_SCAN_INTERVAL_MINUTES } from './mirrorLimits';

const DUENESS = `CASE WHEN last_scan_at > NOW() THEN 'infinity'::timestamptz ELSE last_scan_at END`;

export function dueConnectionsSql(table: 'imap_mirror_connections' | 'sent_mirror_connections'): string {
  return `SELECT c.* FROM ${table} c
  JOIN (SELECT id, ${DUENESS} AS dueness,
               ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY ${DUENESS} ASC NULLS FIRST, id) AS rn
          FROM ${table}
         WHERE status = 'active'
           AND (last_scan_at IS NULL
                OR last_scan_at > NOW()
                OR last_scan_at < NOW() - (GREATEST(scan_interval_minutes, ${MIN_SCAN_INTERVAL_MINUTES}) || ' minutes')::INTERVAL)) d
    ON d.id = c.id AND d.rn = 1
  ORDER BY d.dueness ASC NULLS FIRST
  LIMIT 20
  FOR NO KEY UPDATE OF c SKIP LOCKED`;
}
