/**
 * A refusal written for the operator (the action route and the MCP tools pass
 * its message through); anything else stays a generic failure. Its own file so
 * businessUnitService and businessUnitUsage share it without an import cycle.
 */
export class BusinessUnitActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusinessUnitActionError';
  }
}
