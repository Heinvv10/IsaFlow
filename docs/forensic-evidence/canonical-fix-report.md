# Canonical binding review corrections

Reviewed baseline2003bddb. Isolated branch fix/mcp-forensic-canonical-20260909. Scope: canonical.ts, extracted bindingValidation.ts and controls contract unit tests. No DB, migrations, auth/context changes, builds or full CI.

All three review findings reproduced before implementation: Unicode-equivalent-but-byte-distinct policy identifiers hashed differently after permutation; invalid nested version/identity/policy/date/money pairs accepted; sparse arrays disguised by extra properties and symbol/accessor decoration silently lost data. First regression run:16failed,23existingpassed, saved /tmp/forensic-canonical-red.log.

Changed set ordering to deterministic JavaScript code-unit comparison of canonical JSON, preserving distinct Unicode spellings. Composite duplicate identities use canonical tuple keys to avoid separator ambiguity. Added structural/material validation before hashing: positive safe integer versions, nonempty text identities/fingerprints/roles, actual boolean mandatory, valid beneficiary types and currency/amount pairs, real YYYY-MM-DD accounting dates, required collection shapes and monetary-operation rules.

Canonical evidence now checks property descriptors: array indices must exist as own enumerable data properties; array symbols/extra properties/holes/hidden payload rejected. Plain object accessors and hidden properties rejected without invoking getters. Dates reject own decorations/subclasses before conversion. Frozen ordinary data remains valid. Whole binding shape is checked before spreads/map/material-field access can lose data or run getters.

Final53tests pass (165ms total,11ms test time). Cases cover all three reference collections' Unicode permutations, positive/negative nested material cases, valid leap dates, invalid calendar dates, frozen data, getters not invoked, array/object symbols and hidden payload. Green log /tmp/forensic-canonical-green.log.

Verification from isolated worktree with Node22.23.1 on PATH:

```
node node_modules/vitest/vitest.mjs run tests/unit/services/controls/contracts.test.ts
node node_modules/eslint/bin/eslint.js src/modules/accounting/services/controls/canonical.ts src/modules/accounting/services/controls/bindingValidation.ts
node node_modules/typescript/bin/tsc --noEmit --project /tmp/forensic-canonical-tsconfig.json
```

Source ESLint passed; focused TypeScript project passed twice, including final tests. Temporary tsconfig extends worktree tsconfig, disables incremental output and includes only the two changed source files and contract test, with exclude=[] so tests are checked. No repository config changes. All owned code files below300lines. Independent review and root integration remain next gates.
