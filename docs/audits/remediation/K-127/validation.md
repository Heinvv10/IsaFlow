# K-127 — portal chatbot sanitiser mangles ordinary English

Baseline: origin/master `31fc2f1062d228f6ebf43049338ecb41767002d0`.

**Claim.** The sanitiser strips characters from normal replies, corrupting customer-facing text.

**Corrected trigger.** Confirmed as written. `INTERNAL_PATTERNS[0]`
(`/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN)\b[^.!?]*/gi`) is case-insensitive on plain
English words and deletes everything from the word to the next sentence terminator;
`/\bquery\b/gi` does the same for one word. The `clean || text` fallback only rescues a reply
stripped to nothing — a partially mangled reply is returned mangled.

**Disposition: confirmed.**

**Evidence.**
- `git show origin/master:src/modules/accounting/services/ar/portalChatbotService.ts` :104-118.
- RED: `tests/unit/services/ar/k127-portal-chatbot-sanitiser.test.ts` — 3 failed, 1 passed.
  "Your invoice from March is still outstanding. Please pay by Friday." →
  "Your invoice Please pay by Friday."; "I will update your contact details. Thank you." →
  "I will . Thank you."; "If you have a query about this account, reply here." loses "query".
  The passing case confirms a genuine leaked SQL statement is still stripped.

**Reachability.** `pages/api/portal/chat.ts:82` applies it to every model reply on the public,
unauthenticated customer portal.

**Proposed minimal fix (1 file).**
Narrow pattern [0] to statement shapes rather than bare keywords — require the SQL to look like SQL,
e.g. `/\bSELECT\b[\s\S]{0,200}?\bFROM\b/gi` plus `/\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b[^.!?]*/gi`
— and delete the standalone `/\bquery\b/gi` rule. Keep the table-name pattern (:106) as-is; it is
specific and does no collateral damage.

**Historical-data impact.** None stored. `portal_chat_messages` (if retained) holds already-mangled
replies; nothing to correct beyond future sends.

**Risks.** Narrowing a security filter. The table-name pattern at :106 remains the real backstop for
schema leakage, and the RED test keeps a genuine-leak case as a regression guard.
