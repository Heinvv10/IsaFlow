# Writing for the ISAFlow blog

The blog lives at `https://isaflow.co.za/blog`. Posts are MDX files in this repo; a pull
request adds or changes them, and Hein approves each batch by flipping the publishing gate
(below). On `app.isaflow.co.za`, every `/blog` URL redirects (308) to `isaflow.co.za`.

## Where files go

```
content/blog/<slug>/index.mdx        the post (preferred)
content/blog/<slug>.mdx              also accepted, for a post with no folder
public/blog/<slug>/hero.webp         hero image, 1600 x 900
public/blog/<slug>/og.webp           social share image, 1200 x 630 (optional)
public/blog/<slug>/screenshot-N.webp screenshots, WebP, any 16:9-ish size
public/blog/<slug>/chart-N.svg       a static chart image, if not using <Chart>
```

- `<slug>` is lowercase kebab-case (`vat-registration-guide`) and must equal the folder
  (or file) name and the `slug` frontmatter field.
- Reference assets by site path: `/blog/<slug>/hero.webp`. `heroImage` and `ogImage` must
  sit under `/blog/<slug>/` and the file must exist, or the build fails.
- Folders and files starting with `_` or `.` are ignored (use `_drafts/` for scraps).

## Frontmatter

```yaml
---
title: "How to register for VAT in South Africa"
slug: vat-registration-guide
description: "When registration is compulsory, what SARS asks for, and how long it takes."
publishDate: 2026-11-03
category: VAT & Tax
tags: [vat, sars]
heroImage: /blog/vat-registration-guide/hero.webp
heroAlt: "A VAT201 return open on a laptop"
ogImage: /blog/vat-registration-guide/og.webp
draft: true
---
```

| Field | Type | Required | Default | Rules |
|---|---|---|---|---|
| `title` | string | yes | | not empty |
| `slug` | string | yes | | kebab-case `a-z 0-9 -`; must match the folder/file name |
| `description` | string | yes | | 1 to 155 characters (meta description and cards) |
| `publishDate` | date | yes | | `YYYY-MM-DD` (live from 00:00 SAST that day) or ISO datetime with offset, e.g. `2026-11-03T09:00:00+02:00` |
| `updatedDate` | date | no | | same formats; must be on or after `publishDate` |
| `author` | string | no | `ISAFlow Team` | |
| `category` | string | yes | | one per post; the index filters on it |
| `tags` | string[] | no | `[]` | |
| `heroImage` | path | yes | | `/blog/<slug>/...`, file must exist in `public/` |
| `heroAlt` | string | yes | | describes the hero image |
| `ogImage` | path | no | `heroImage` | `/blog/<slug>/...`, file must exist |
| `draft` | boolean | no | `false` | `true` keeps the post out of production |
| `readingTime` | integer | no | computed | minutes; overrides the computed value (220 words/minute) |

Any other key is an error, so a typo such as `publishedDate` fails the build instead of
being ignored. Every error names the file and the field, for example:

```
Invalid blog frontmatter in content/blog/vat-registration-guide/index.mdx:
  - description: must be at most 155 characters
```

## Components

Markdown is GitHub-flavoured: tables (with `:--`, `:-:`, `--:` alignment), `~~strike~~`,
task lists (`- [ ]`), and bare URLs become links. Code blocks use fences.

### Chart

```mdx
<Chart
  type="bar"
  title="Invoices sent per month"
  source="ISAFlow demo company, 2026"
  data={[
    { label: "Jan", value: 12 },
    { label: "Feb", value: 18 },
  ]}
/>
```

Props: `type` (`bar` | `line` | `pie`), `title`, `source` (shown as "Source: ..."), `data`.
Optional: `unit` (`"R"` prefixes rand, anything else is a suffix such as `"%"`), `height`
(160 to 800, default 320).

Data shapes:

- **Single series** (bar, line, pie): `[{ label: string, value: number }, ...]`
- **Multi series** (bar and line only): `[{ label: string, values: { [seriesName]: number } }, ...]`.
  Every row must have the same series names. A legend is shown.

```mdx
<Chart type="line" title="Income and expenses" source="Demo data" unit="R"
  data={[
    { label: "Q1", values: { Income: 42000, Expenses: 31000 } },
    { label: "Q2", values: { Income: 48000, Expenses: 33500 } },
  ]}
/>

<Chart type="pie" title="Expense split" source="Demo data" unit="%"
  data={[
    { label: "Salaries", value: 55 },
    { label: "Rent", value: 20 },
    { label: "Other", value: 25 },
  ]}
/>
```

Pie values must be zero or more and add up to more than zero. An invalid chart fails the
build with the post's path and the bad prop. Charts render as static SVG (no JavaScript)
on a light card, with a hidden data table for screen readers.

### Screenshot, Figure, Callout

```mdx
<Screenshot src="/blog/<slug>/screenshot-1.webp" alt="The VAT201 screen" caption="Optional caption" />

<Figure caption="Anything with a caption">
  ![alt](/blog/<slug>/chart-1.svg)
</Figure>

<Callout type="tip" title="Optional title">
  Text with **markdown**. Types: info, tip, warning.
</Callout>
```

`Screenshot` assumes 1600 x 900; pass `width` and `height` for other sizes. `alt` is
required. Screenshots must show demo data only, never a real customer.

## The publishing gate (how Hein approves a batch)

A post is **published** when `draft` is `false` and `publishDate` has passed. Until then it
is a 404 in production and is left out of the index, `/sitemap.xml` and `/blog/rss.xml`.

1. Echo opens a PR with the posts at `draft: true`.
2. Hein reviews them in preview (below).
3. To approve, set `draft: false` (and adjust `publishDate` if scheduling). Merge and deploy.
4. A post with a past `publishDate` is live on that deploy. A post with a future
   `publishDate` goes live on its own, without a deploy: pages regenerate at most once an
   hour (ISR), so it appears within about an hour after its date. The sitemap and RSS are
   cached for an hour.

## Preview

Drafts and scheduled posts render, with a DRAFT/SCHEDULED banner and `noindex`, when
`NODE_ENV` is not `production` (that is, `bun run dev`) or when the server runs with
`BLOG_PREVIEW=1`. Never set `BLOG_PREVIEW=1` on the production service: it makes drafts
reachable by URL. The sitemap and RSS never list unpublished posts, even in preview.

## Checking a post locally

```bash
bun run dev                     # then open http://localhost:3200/blog/<slug>
bunx vitest run tests/unit/blog # validates every file in content/blog (frontmatter, slugs, images)
```

The `content.test.ts` suite loads the real `content/blog`, so a broken post fails CI
before it reaches a build.
