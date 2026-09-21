# K-092 — AFS image fetch has no SSRF guard

**Claim.** `pages/api/accounting/afs/images.ts:16` checks only the `https://` prefix and omits
the `checkPublicUrl()` guard "the sibling route applies to the same fetch sink".

**Corrected trigger.** The premise is the shared sink, and it does not exist. The sibling
route's guard exists because `brandProfile.logoUrl` **is** fetched server-side: WeasyPrint
resolves it while rendering the PDF, which is why `pdfExportService.ts:141` re-checks it
before rendering as well as `brand-profile.ts:53` before storing. The AFS image URL has no
such consumer.

**Disposition: false-positive as reported** — a defence-in-depth gap, not a reachable SSRF.

**Evidence (disconfirming).** Every read of the stored value, on `origin/master`:
- `git grep -n "afs_uploaded_images" -- src pages` → `imageLibraryService.ts` (35, 42, 62, 96)
  and `afsPreExportChecks.ts:362`. The pre-export check selects `id` only, filtered on
  `low_res_warning`; it never touches `url`.
- `git grep -n "listImages\|imageLibraryService" -- src pages` → only `pages/api/accounting/afs/images.ts`
  and `images/[imageId].ts`. No component, template or PDF path imports it.
- `git grep -n "afs/images" -- src pages | grep -v "pages/api"` → no hits. Nothing in the UI
  calls the endpoint either.

So the URL is validated by Zod, stored, and returned to the caller who stored it. No server
process resolves it, so there is no request for an attacker to redirect at `169.254.169.254`
or an internal host. Reflecting it back to its own author is not an SSRF.

**Reachability.** The write path is reachable (`POST`, `withAuth` + `withCsrf`, any
authenticated user of the company). The *impact* is not.

**Proposed minimal fix (defence in depth, not a security fix).** These rows are tagged
`cover` / `section_divider` / `inline`, i.e. they exist to be rendered into a report. The
moment anything renders them the gap becomes live, and the same fix the sibling uses is two
lines: `import { checkPublicUrl } from '@/lib/safeFetch'` and, in the POST branch,
`const reason = await checkPublicUrl(parsed.data.url); if (reason) return apiResponse.badRequest(res, ...)`.
Worth doing when the render path lands; not worth an incident today.

**Historical-data impact.** None. No fetch has ever been issued from these rows. Existing
`afs_uploaded_images.url` values were never resolved server-side, so nothing needs re-checking.

**Risks.** `checkPublicUrl` does a DNS resolution per POST; on an air-gapped or
egress-filtered deploy that turns image uploads into 400s. The sibling route already accepts
that trade, so the behaviour would at least be consistent.
