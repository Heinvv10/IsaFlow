# R-004 independent assessment

Reviewer /root/r004_assess confirmed at commit6d42b2ac that scalar XML functions pass both query guards and return a synthetic marker from a temporary relation outside the relation allowlist. Probe used disposable PostgreSQL only and rolled back. Artifacts originally /tmp/isaflow-r004-qu7y37oc. No production role/RLS or live endpoint impact was tested.

Root cause: relation discovery cannot interpret string arguments to functions, and the separate tenant scope guard permits SELECT without FROM. Required correction: explicit analytical function capability validation throughout the AST, with allowed aggregates/date functions retained. Read-only execution alone does not prevent reads. This remains distinct from K008.

Evidence limitation: independent follow-up review found the preserved probe only checks guards, not database output. The platform blocked additional evidence capture. The reviewer-reported database result is not independently replayable from committed artifacts; retain this unresolved check.
