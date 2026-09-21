# K-098 — CRITICAL_ACTIONS names match no emitted action

**Baseline:** origin/master `31fc2f10`; `auditService.ts` unchanged since the audited `5661d6f0`.

**Claim vs corrected trigger.** Claim: the list "uses action strings no route emits, so critical
admin actions never alert." Corrected: 13 of 17 names DO match emitted actions, and the mechanism
is a fail-closed ROLLBACK gate, not an alert. Exactly two names are dead — `feature.override` and
`feature.remove_override` — because the feature-override routes emit
`company_feature.override_set` / `company_feature.override_removed`
(`pages/api/admin/companies/[id]/features.ts:63,91`). `user.impersonate` is unused too, but the
impersonation route emits `impersonation_start` (`users/[id]/impersonate.ts:85`), which is in the
set, so that entry is redundant rather than a hole.

**Disposition: confirmed (narrowed).** Reported high; corrected **medium** — the blanket claim is
false, the residual hole is one action pair.

**Evidence.** Enumerated every `logAdminAction` call site on origin/master (50 distinct action
strings) and diffed against `CRITICAL_ACTIONS` (`src/modules/admin/services/auditService.ts:41`).
Matching: `user.suspend`, `user.reset_password`, `user.update`, `user.force_logout`,
`impersonation_start`, `company.suspend`, `company.delete`, `company.impersonate`,
`company.activate`, `company.export_data`, `subscription.cancel`, `subscription.update`,
`plan.update`, `plan.archive`. Dead: `feature.override`, `feature.remove_override`,
`user.impersonate`.

**Reachability.** POST/DELETE `/api/admin/companies/[id]/features` write the override, then call
`logAdminAction`. The action name is not in the set, so a failed audit INSERT is swallowed
(`auditService.ts:80-90`), `ctx.criticalAuditFailed` stays unset, and `withPlatformAdmin` COMMITs
the override with no audit row.

**RED test.** `tests/unit/k098-critical-actions-dead-names.test.ts` — 2 failed, 1 passed. The
passing case is the `company.suspend` control, which proves the harness reaches the gate and
disproves the "matches no emitted action" wording. Output in `red.log`.

**Proposed fix.** In `auditService.ts`, replace `'feature.override', 'feature.remove_override'`
with `'company_feature.override_set', 'company_feature.override_removed'` and drop the unused
`'user.impersonate'`. Keep the unit test as the regression guard.

**Historical impact.** No corrupted rows; the loss is audit coverage, and only where the audit
INSERT itself failed. Read-only check: `SELECT o.company_id, o.feature_id FROM
company_feature_overrides o WHERE NOT EXISTS (SELECT 1 FROM admin_audit_log a WHERE a.target_id =
o.company_id::text AND a.action LIKE 'company_feature.%');`

**Risk.** Adding the names turns a previously-swallowed audit failure into a 500 plus rollback on
those two routes. That is the intended fail-closed behaviour, but it is a behaviour change.
