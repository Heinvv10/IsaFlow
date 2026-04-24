# pdf-to-image.ts

## Purpose
Server-side PDF→PNG conversion using the `pdftoppm` binary (poppler-utils) at 300 DPI — used by VLM extraction pipelines (invoice capture, CIPC COR39 director parsing).

## Key exports
- `pdfToImage(pdfDataUrl: string): Promise<string>` — converts first page only; returns `data:image/png;base64,...`
- `pdfToImages(pdfDataUrl: string, maxPages?: number): Promise<string[]>` — converts up to `maxPages` pages (default 8); returns array of data URLs

## Dependencies
- `pdftoppm` binary at `/usr/bin/pdftoppm` — poppler-utils system package
- `child_process.execFile` (wrapped with `util.promisify`) — argv passed as an array, no shell interpolation
- `fs.promises`
- `@/lib/logger`

## Critical notes
- Server-only — writes to `/tmp` and spawns a subprocess. Never import in client code.
- Uses `execFile` (not the shell-form sibling) so PDF contents cannot shell-inject. Args are an argv array — do not rewrite to string-concat a shell command.
- **DEFAULT_MAX_PAGES = 8** — hard cap so a malicious 1000-page PDF can't fan out into hundreds of VLM calls. Do not raise without reviewing downstream VLM cost.
- Both functions generate a UUID-based temp filename to avoid collisions across concurrent requests.
- Temp files are unconditionally unlinked in `finally`, with errors swallowed — leaks only on SIGKILL of the node process.
- `pdfToImages` reads the tmp directory and filters by `<stem>-*.png`; it relies on lexical sort matching zero-padded page numbers (poppler zero-pads when total pages has ≥2 digits).
- Throws `Error: pdftoppm did not produce output file: ...` when poppler silently fails (e.g. encrypted PDF) — callers should treat as a user-facing "unsupported PDF" error.
- Input must be a `data:application/pdf;base64,...` URL — the regex strip allows either exact prefix or plain base64.
- Single-page mode passes `-singlefile` so the output path is stable (`<stem>.png`); multi-page mode omits it so poppler numbers the files.

## Recent changes
- 2026-04-24: Added `pdfToImages` multi-page variant for CIPC COR39 director extraction.
- 2026-04-10: VLM service refactor adopted this module.
