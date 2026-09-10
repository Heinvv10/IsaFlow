# Legacy comparison retry and atomic conversion proof

Base: `519cec04e`. Owner: `legacy_retry_proof`. This branch owns only the new
`tests/integration/controls/auditComparisonLegacyRetry.int.test.ts` and this document.
No production service or migration changes.

Six PostgreSQL regression scenarios exercise real enqueue, signed saved requests,
real worker execution, current company permissions and retained database rows:

- A genuine current enqueue is converted by privileged local fixture setup to an
  authenticated historical v1 request pinned to actual source canonical hashes.
  Lowercase and uppercase historical UUID variants must retry to the same queued
  and subsequently succeeded job without changing any original intent column.
- Changing the ordered source pair conflicts; caller supplied permissions fail.
- Current banking permission revocation denies the historical retry.
- An authenticated v1 intent with a wrong source hash cannot be silently upgraded.
- Two genuine snapshots lose their original indexes and comparison companions in
  fixture setup. The lexically second original seal is corrupted. The actual worker
  must fail, retain no new original indexes, source projections or comparison output,
  preserve both original rows exactly as found, and retain a failed job without a
  success pointer. A fixture-scoped nontransactional sequence incremented by an
  AFTER INSERT trigger proves the first index was inserted before rollback.

Production regressions detected: overwriting historical protected intents on retry;
comparing v1 and v2 hashes directly; dropping pinned-hash or current-rights checks;
UUID case mismatch; committing the first conversion independently of the second.

Validation pending the orchestrator's exclusive PostgreSQL lease. These tests add
coverage against existing implementation; no new production RED/GREEN claim yet.
