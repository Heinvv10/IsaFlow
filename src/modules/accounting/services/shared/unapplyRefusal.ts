/**
 * A refusal from an un-apply plan: raised from reads, before anything is
 * written, with a message safe to show the caller. The MCP tools return it as
 * a toolError; anything else they rethrow so the registry unwinds.
 */
export class UnapplyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnapplyRefusal';
  }
}
