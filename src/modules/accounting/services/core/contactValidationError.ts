/** A contact write refused before any SQL ran: the REST routes answer 400, the MCP tools a toolError. */
export class ContactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContactValidationError';
  }
}
