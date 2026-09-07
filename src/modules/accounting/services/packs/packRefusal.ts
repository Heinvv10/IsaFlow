/**
 * A REFUSAL A USER CAN READ, AND A DIAGNOSTIC AN ENGINEER CAN USE.
 *
 * The pack route reports a failed render by re-composing in this process and
 * returning what the gate refused on, verbatim (`packs/[id]/pdf.ts`). For
 * `assertPackIntegrity` that is exactly right — "the balance sheet is out by
 * R450 on …" is a fact about the company's own ledger and the whole value of
 * the gate.
 *
 * It is wrong for a LAYOUT refusal. `fitPageToBox` reaches the user beginning
 * "fitPageToBox:" and quoting 264.9mm against 255mm — an internal function
 * name and a millimetre budget, on the one screen a user sees when everything
 * else has already failed, describing something they cannot act on. The
 * millimetres are what an engineer needs; they are not what a reader needs.
 *
 * So the two audiences are carried separately. `message` stays the full
 * diagnostic and is what gets logged; `userMessage` is the sentence the route
 * returns. Anything thrown that is NOT one of these keeps the old behaviour —
 * its message is the user's message — because the integrity gate's sentences
 * are written for a reader already.
 */
export class PackRefusal extends Error {
  readonly userMessage: string;

  constructor(diagnostic: string, userMessage: string) {
    super(diagnostic);
    this.name = 'PackRefusal';
    this.userMessage = userMessage;
  }
}

/** What a caller should show a person about `error`, and what it should log. */
export function packRefusalMessages(error: unknown): { user: string; diagnostic: string } {
  if (error instanceof PackRefusal) {
    return { user: error.userMessage, diagnostic: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { user: message, diagnostic: message };
}
