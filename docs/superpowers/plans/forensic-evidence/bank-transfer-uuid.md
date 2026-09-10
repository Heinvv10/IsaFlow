# Bank transfer UUID identity and retained receipt verification

Owned base: `deac7b7e5`. Implementation: `df3eb854b`.
Tests-first commits: `9f6afca06`, `723288bb5`, `6f05c8011`.
Root independently reviewed the owning source and tests before requesting the
shared compatibility dependencies: `6228078e0` and `f67ad824a`, cherry-picked as
`3bcb454c5` and `2318356f6`.

The owning service validates and lowercases intent UUIDs before receipt queries,
callbacks and new result construction. Existing receipts are looked up by UUID
case-insensitive identity, must be unique, and retain their exact saved result.
The existing company, requester, current permission, independent approval and
posted journal association checks remain active. No retained records are edited.

## Tests-first and initial verification

- Actual PostgreSQL `27908`: three genuine failures.
- Actual PostgreSQL `26926`: four genuine failures, including a transfer posted
  twice after separately approving a UUID case variant. Posted debits and credits
  were each **20.00 instead of 10.00**. The remaining failures were both current
  case/retry paths and a genuinely retained baseline uppercase receipt.
- Baseline seed `59296`: terminal exit 0. The exact production source at
  `a62c492cd` ran from `.worktrees/mcp-bank-transfer-legacy-seed-20260910`.
  The test helper created a synthetic company, two bank accounts, a transfer,
  independent human approval and a posted journal through actual services under
  `app_user`. It verified the retained effect and returned result used uppercase
  identities, then wrote a mode-0600 fixture manifest. No immutable row was
  rewritten to manufacture this state.
- After the owning fix, actual PostgreSQL `45275`: **3 passed**.
- Existing `glBypassMaterials.int.test.ts`, run `42920`: **11 passed**, followed
  by dedicated TypeScript and typed ESLint with zero warnings, terminal exit 0.
- Genuine baseline replay initially remained RED because the shared replay kernel
  still used a case-sensitive effect association. Root owns that correction.

Durable logs/configs/manifests are in sibling `mcp-forensic-artifacts-20260909`,
with prefixes `bank-transfer-uuid-` and `bank-transfer-legacy-uuid-`. The fixture
manifest contains synthetic encryption keys; do not publish its contents.

## Final dependency verification

Final run `75514`, terminal exit 0 on source `2318356f6`: **15 actual PostgreSQL tests passed** (3 current UUID scenarios, 1 genuine baseline legacy scenario and 11 existing GL/bypass compatibility scenarios). Dedicated TypeScript and typed ESLint also passed, with zero warnings. Logs: `bank-transfer-uuid-final-pg.log`, `bank-transfer-uuid-final-static.log`, `bank-transfer-uuid-final-lint.log`.

The legacy test compared entire retained effect and approval rows before and after both UUID-case retries, and verified the original single journal. Both saved uppercase results were returned unchanged. This is local synthetic verification; it makes no production, deployment or real-transaction claim.

The final queued run started only after both other programme workers were terminal and process inspection confirmed no remaining platform-worker PG/static process. The heavy lease is released. Root owns independent integration review and the final programme CI gate.
