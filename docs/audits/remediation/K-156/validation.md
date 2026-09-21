# K-156 — IMAP mirror cursor advances past a message whose ingest failed

- **Claim (medium):** `maxUidSeen` is persisted regardless of attachment errors, so a transient failure loses the message permanently.
- **Corrected trigger:** confirmed as stated. In `scanConnection` (`imapMirrorService.ts`, region shown by `git show origin/master:<path> | sed -n '295,365p'`), `maxUidSeen` is raised at the *top* of the loop for every message examined, before any filter or ingest runs. The per-message `try/catch` around `ingestAttachment` records an `outcome:'error'` scan-log row, increments `result.errors`, and continues; the cursor write afterwards persists `maxUidSeen` unconditionally when it exceeds the old cursor. The next scan searches `${cursorUid + 1}:*`, so the failed UID is never fetched again. The service never marks messages read or deleted, so there is no other trace to recover from.
- **Disposition:** `confirmed`.

## Evidence
- File unchanged between 5661d6f0 and origin/master.
- Reachability: `scanAllDueConnections` iterates every `status='active'` connection on the poll interval; `ingestAttachment` performs a storage upload (`storeCapturedBytes`) and four SQL statements, all of which can fail transiently.
- RED: `tests/unit/services/capture/k156-imap-cursor-advances-past-failure.test.ts` — 1 failed / 1. Log: `red.log`. Two messages (UID 11 ingests, UID 12's upload throws); the assertion `result.errors === 1` passes, proving the failure path was exercised, and the persisted `scan_cursor.INBOX` is 12 where it must be 11.

## Harm
A supplier invoice that arrived by mirrored mailbox is silently never captured. The only record is an `imap_mirror_scan_log` row with `outcome='error'`, which no UI surfaces as a work queue. The books are short one payable with nothing to reconcile against.

## Proposed minimal fix
Track the highest *safe* UID rather than the highest seen. Initialise `let maxUidSeen = cursorUid` as now, but move the raise out of the top of the loop: advance it only at the points that conclude a message needs no retry — the `denied_sender`, `skipped_not_invoice`, `skipped_no_attachment` and successful-`ingested` branches — and leave it alone in the `catch (ingestErr)` branch and the `!full.source` branch. Because UIDs are ascending, a failure must also stop any later message from raising the cursor past it, so break out of the loop (or latch a `blockedAt` UID and cap `maxUidSeen` below it) on the first error. About 6 lines.

## Historical-data impact
Messages already skipped cannot be identified from the application database alone — the mailbox still holds them, unread and unmarked. Enumerate the lost UIDs and re-scan by lowering the cursor:

```sql
SELECT connection_id, company_id, imap_uid, sender, subject, error, created_at
FROM imap_mirror_scan_log
WHERE outcome = 'error'
ORDER BY created_at DESC;
```
For each connection, set `scan_cursor` back to `MIN(imap_uid) - 1` over its error rows to force a re-scan after the fix. Re-scanning is safe for the already-ingested messages only insofar as there is no ingest idempotency — see K-160, whose absence of a message-id guard means a re-scan would duplicate the documents it did capture. Sequence the two fixes: land the K-160-style dedupe before replaying any cursor.

## Risks
Halting the cursor on error means one permanently-failing message (a corrupt attachment, a file too large) blocks every later message on that connection. Pair the fix with a retry counter on the scan-log row, or an operator-visible "connection stuck at UID n" state, so a poison message is surfaced rather than silently stalling the mailbox.
