# Current MCP registry fixture refresh

Base cade9485a (source c4b2c9859); root owns exactly tools-read.test.ts, tools-write.test.ts, listGlAccountsTool.test.ts and this plan. Full CI26716 and focused70152 reproduce five failures: obsolete77/141 counts, missing two post-gated names/four write scan inputs, and default pending-approval read reaching an unmocked issued transaction.

Update exact current80/148 counts and explicit32 posting-scope names, add four write validation-refusal samples to the existing credential-envelope scan, and an explicit invalid pending-page sample matching this suite's existing control-reader refusal scope. Keep every original success/tenant/credential assertion and exhaustive write-keyset check. Dedicated real control tests/HTTP prove successful/current-authority behavior; this scan has always included refusal envelopes and must not be described as all-tool happy-path proof. No production behavior or auth mocks change.

Focused command: bunx vitest run tests/unit/mcp/tools-read.test.ts tests/unit/mcp/tools-write.test.ts tests/unit/mcp/listGlAccountsTool.test.ts. Independent review and integration only after GREEN; remaining123 CI failures are not presumed fixture-only.

Focused70152 reproduced5fail/62pass. First correction90013 left one expected-array sorting mismatch (66pass), preserved in WIP0a295e460; corrected literal posting-name order without changing assertions. Final66044: all67tests3filesPASS, registry-fixture-refresh-final.log. No production service or authority changes. Independent named review remains pending.
