# K-127 — portal chatbot sanitiser stops mangling ordinary English

**Trigger.** `INTERNAL_PATTERNS[0]` was `/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN)\b[^.!?]*/gi`
— case-insensitive on plain English words, deleting everything from the word to the next `.!?`. A
second rule deleted the bare word "query". The `clean || text` fallback only rescues a reply stripped
to nothing, so a partially mangled reply was sent to the customer as-is, on the public unauthenticated
invoice portal (`pages/api/portal/chat.ts:82`).

**Before.** "Your invoice from March is still outstanding. Please pay by Friday." →
"Your invoice Please pay by Friday."; "I will update your contact details. Thank you." →
"I will . Thank you."
**After.** The keyword rule is replaced by two statement-shaped rules — `SELECT … FROM …` (bounded to
200 chars so it cannot run past a sentence) and `INSERT INTO` / `UPDATE <t> SET` / `DELETE FROM` — and
the standalone `query` rule is deleted. The table-name, `table \w+` and `column \w+` rules are
untouched and remain the backstop for schema leakage.

**Files.** `src/modules/accounting/services/ar/portalChatbotService.ts` (`INTERNAL_PATTERNS`).

**Tests.** `tests/unit/services/ar/k127-portal-chatbot-sanitiser.test.ts` — 10 passed:
three ordinary-English replies survive intact ("from", "update", "query"); genuine leaks are still
stripped (SELECT…FROM, INSERT INTO, UPDATE…SET, DELETE FROM) including the table names; a SELECT no
longer swallows the following sentence; the strip-to-nothing fallback still returns the original;
"join … delete … where" in plain English survives.
Mutation check: reverting the file to origin/master → 5 failed.

**Migration / rollback.** None. Revert the commit.

**Historical-data impact.** None stored. `portal_chat_messages` retains already-mangled replies;
nothing to correct beyond future sends.

**Limits.** This narrows a security filter. A leak that is neither a recognisable statement shape nor a
known table/column name would now pass; the table-name rule is the remaining guard, and the tests keep
four genuine-leak regression cases.

## Round 2 (blind review H1, H2, L2)
The first fix left the headline false positive in place and failed OPEN. The sanitiser now
classifies whole SENTENCES and drops the offending one rather than editing in place, normalises
zero-width characters first, and returns `SANITIZED_FALLBACK` — never the raw text — when nothing
survives. The test asserting the fail-open as correct behaviour is inverted.
