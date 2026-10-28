# ISAFlow marketing blog — design (2026-10-27)

Spec approved by Hein on 27 Oct 2026. This run was non-interactive: the brainstorm
questions were answered from the spec and the codebase. Every "my call" below is the
builder's decision, not Hein's.

## Intent

A blog at `https://isaflow.co.za/blog` that Echo (content writer) fills with MDX files
and Hein approves batch by batch. The gate is the frontmatter: `draft: true` or a future
`publishDate` keeps a post out of production entirely (404, index, sitemap, RSS).

Goals: static, fast, SEO-complete pages that look like the landing page; loud build
failures on bad content; a safe production default.
Non-goals: a CMS, comments, search, author pages, pagination, newsletter.
Anti-goals: a draft leaking to production; MDX/chart JS landing in the app bundle; any
change to how the app host or its auth behaves.

## What the codebase told me

- **Host routing** (`middleware.ts`): there is no separate marketing app. All hosts serve
  the same Next.js build. `pages/index.tsx` is the landing page (ISR, from PR #758);
  `app.isaflow.co.za` redirects `/` to `/accounting`; `admin.isaflow.co.za` rewrites to
  `/admin/*`. Auth only gates `/accounting` and `/payroll`, so `/blog` is already public
  for anonymous visitors on the marketing host.
- **Production CSP** is `script-src 'self'` (no `unsafe-eval`). `next-mdx-remote`
  hydrates MDX with `new Function` in the browser, which that CSP blocks. So MDX must not
  run in the browser at all.
- `recharts` and `echarts` are installed but both are client-side libraries; using them
  would put chart JS on blog pages and need hydration.
- No sitemap or robots file exists.
- `output: 'standalone'`: files read with `fs` at ISR time must be force-traced into the
  standalone output, as `next.config.js` already does for sharp/pdf-parse.
- Census tests: display font sizes (`text-3xl`+) are allowed only under
  `src/components/landing/` (and legal/present); raw `text-gray-400/500` is counted by
  a shrink-only gate; hand-made dates are banned outside `src/lib/`.

## Decisions (my calls)

1. **MDX compiled to static HTML at build/ISR time** with `@mdx-js/mdx` `evaluate` +
   `react-dom/server` inside `getStaticProps`. The page renders that HTML with
   `dangerouslySetInnerHTML`. Zero MDX runtime in the browser, no CSP change, nothing
   added to any client bundle (Next strips `getStaticProps`-only imports). Content is
   trusted (repo files reviewed via PR), so JS expressions in MDX (`data={[...]}`) are
   allowed.
2. **Charts are hand-rolled SVG** (bar, line, pie), rendered server-side into that HTML,
   with an accessible data table. No chart library.
3. **Chart data shape** (pie legend is HTML beside the donut so it reflows; bar/line SVGs
   keep a 520px minimum width inside a horizontal scroller so labels stay legible): single series `{ label, value }[]`; multi-series (bar and line
   only) `{ label, values: { [series]: number } }[]` with the same series keys on every
   row. Validated with zod; an invalid chart fails the build naming the post.
4. **App host:** `/blog`, `/blog/*` and `/sitemap.xml` on `app.isaflow.co.za` get a 308
   to the same path on `https://isaflow.co.za`. A redirect keeps any stray link working
   and consolidates SEO on one host; a 404 would lose both.
5. **Routes:** `/blog` (SSG + ISR 1h, client-side category filter synced to
   `?category=`), `/blog/[slug]` (SSG, `fallback: 'blocking'`, ISR 1h), `/blog/rss.xml`
   and `/sitemap.xml` (SSR with `s-maxage=3600`, so they are always current).
6. **Publish time:** `publishDate` is `YYYY-MM-DD` (live from 00:00 SAST that day) or a
   full ISO datetime with offset. A scheduled post goes live on the first build or ISR
   revalidation after that moment (worst case ~1 hour after, without a deploy, because
   `[slug]` uses `fallback: 'blocking'` and the index revalidates hourly).
7. **Preview:** shown when `NODE_ENV !== 'production'` or `BLOG_PREVIEW=1`. Preview pages
   carry a DRAFT/SCHEDULED banner and `noindex`. Sitemap and RSS never include drafts or
   scheduled posts, even in preview.
8. **Frontmatter is `.strict()`:** an unknown key (a typo like `publishedDate`) fails the
   build. Image paths must sit under `/blog/<slug>/` and the file must exist in `public/`.
9. **Layout:** reuse `LandingNavbar` + `LandingFooter` and the dark `#050a0f` header band
   from `LegalPage`, teal accent. Blog UI lives in `src/components/landing/blog/` (allowed
   display sizes); pure logic in `src/lib/blog/`.
10. **No navbar link to the blog yet** — an empty blog linked from the landing page would
    look broken until Echo's first batch is approved. Follow-up once posts are live.
11. **Theme (added on resume):** the landing body is white with a dark hero band and
    dark navbar, so the blog matches: dark navbar, dark `#050a0f` band holding the
    breadcrumb/title/meta, white article body with slate-700/900 text, light charts
    (white card, slate axes and labels, a teal-led palette that holds 3:1 on white).
12. **GFM (added on resume):** `remark-gfm` in the MDX compile (tables, strikethrough,
    task lists, autolinks). Tables get a horizontal-scroll wrapper, a dark header row,
    row borders with zebra striping and tabular figures; GFM column alignment arrives as
    an inline `text-align` on each cell and wins over the default left alignment.
13. Sitemap lists the public marketing pages (`/`, `/pricing`, `/contact`, `/privacy`,
    `/terms`) plus `/blog` and every published post.

## Left to the builder / follow-ups

- `robots.txt` pointing at the sitemap (not in scope).
- Navbar "Blog" link once the first batch is live.
- Static `/blog/category/<cat>` pages if category SEO matters later.
