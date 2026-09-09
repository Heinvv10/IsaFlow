# K-159 — the WhatsApp amount parser glues space-separated digit groups

- **Claim (medium):** space-separated thousands are concatenated into a much larger number.
- **Corrected trigger:** the direction is inverted. Space-separated thousands ("R1 500") parse *correctly* — that is the feature the `\s` in the character class exists for, and it is documented at `whatsAppTextCommandParser.ts:18`. The defect is that the same class swallows the **next, unrelated** number in the message: `AMOUNT_RE` at `:21-22` is `[\d][,\s\d]*`, so anything of the form "R<amount> <number> <word>" is read as one number.
- **Disposition:** `confirmed` (with the corrected trigger).

## Evidence
- File unchanged between 5661d6f0 and origin/master.
- Measured against the shipped regex:

| message | parsed amount |
|---|---|
| `paid R850 2 lunches at Kauai` | 8502 |
| `paid R120 3 coffees` | 1203 |
| `R250 12 Aug Engen` | 25012 |
| `R1 500 Engen` | 1500 (correct) |

- Backtracking saves the case where the following token is letter-adjacent (`R850 2x lunch` parses as 850), so the misfire needs a space after the second number — which is the common shape for a quantity or a date.
- Reachability: `whatsAppInboundService.ts:244` calls `parseExpenseCommand(payload.Body)` on every inbound WhatsApp message, and `:250-269` materialises a `capture_events` row whose `error` column carries `'wa-text-command: R' + amount`. That is what the operator sees in the capture inbox and promotes from.
- RED: `tests/unit/services/capture/k159-whatsapp-amount-glue.test.ts` — 2 failed / 1 passed. Log: `red.log`. The passing test is the guard that "R1 500" must keep parsing as 1500.

## Harm
An expense is presented for promotion at roughly 10x to 100x its real value ("R250 12 Aug" reads as R25 012). PRD §9 bans auto-publish here, so a human sees it before it reaches the GL — the damage is bounded by whether that human notices, which is exactly what a plausible-looking number defeats.

## Proposed minimal fix
Require a separator to be *followed by* a digit group of exactly three, so a thousands separator is distinguishable from a following number. Replace the number body `[\d][,\s\d]*` with `\d{1,3}(?:[,\s]\d{3})*|\d+` in both alternatives of `AMOUNT_RE` (`:21-22`). `parseAmount`'s existing `.replace(/[\s,]/g,'')` at `:55` still normalises the match, and `extractSupplierHint` at `:93` still strips the same token. Two lines.

## Historical-data impact
Nothing was posted to the GL from this path. The wrong amounts sit in `capture_events.error` as text and in whatever provisional entries an operator promoted from them:

```sql
SELECT id, company_id, received_at, subject, error
FROM capture_events
WHERE channel = 'whatsapp' AND error LIKE 'wa-text-command: R%'
ORDER BY received_at DESC;
```
Compare each `error` amount against the digits in `subject` (which holds the raw body) to find the glued ones. Any that were promoted need the promoted entry checked by hand.

## Risks
Tightening the pattern will reject a genuinely-malformed thousands group that the loose version happened to accept (e.g. "R1 50 000"). Those now parse as 1 rather than 150000, which is a visible wrong answer rather than a silent one — acceptable, but worth a fallback that returns null instead of a truncated amount when the remainder of the token is also numeric.
