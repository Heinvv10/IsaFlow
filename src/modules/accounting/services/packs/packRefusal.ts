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
 * returns.
 *
 * AND ANYTHING THROWN THAT IS NOT ONE OF THESE GETS A FIXED SENTENCE. It used
 * to get its own `error.message`, on the reasoning that the integrity gate's
 * sentences are written for a reader already — but the gate's sentences all
 * come through `PackRefusal`, and the fall-through was carrying every OTHER
 * throwable in the compose stack to the client in a 422 body: a node-postgres
 * driver error with its query text, a `TypeError` from a composition module,
 * an assertion naming an internal function. `packs/[id]/pdf.ts` wraps the
 * whole of `buildBoardPackDocument` in one catch, so the class of message was
 * bounded by nothing. The raw text still goes to the log, on `diagnostic`,
 * which is the field the route already logs.
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
  return { user: UNEXPLAINED_FAILURE, diagnostic: message };
}

/** What a reader is told when the pack failed for a reason that was not
 *  written for them. The engineer's version is on `diagnostic`. */
export const UNEXPLAINED_FAILURE =
  'This pack could not be built. The failure has been logged; please try again, and tell your '
  + 'administrator if it keeps happening.';
