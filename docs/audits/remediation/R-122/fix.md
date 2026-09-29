# R-122: not reproduced (2026-09-29)

Migration 397 (commit 512c4d456, 2026-04-19) already replaced 396's `request.jwt.claims->>'company_id'` policies with `app.current_company_id` policies, and withAuth sets that GUC.

On dev, as reporting-qa, the web app returns all of the ISAFlow Demo leave: 14 requests, 5 types and 40 balances. That holds through the API, through the list page (`r122-demo-leave-list.png`), and as app_user with withAuth's GUCs.

No migration was written. The behaviour is pinned by the R-122 cases in `tests/integration/r135-r136-leave-approver-write-access.int.test.ts`, and the M6 mutation, which puts 396's claim form back, turns them red.

Full evidence and a prod policy census query are in `../R-135/fix.md`.
