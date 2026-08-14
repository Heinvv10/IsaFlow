/**
 * Errors for the agent-facing bank statement import.
 *
 * Split out of bankStatementImportService.ts, which the class pushed to 308
 * lines against the repo's 300-line cap.
 */

/**
 * Thrown for problems found BEFORE importStatementForAgent writes anything —
 * currently a statement whose dates cannot be parsed, which makes duplicate
 * detection impossible.
 *
 * Typed rather than a bare Error so the MCP tool can report "this statement is
 * unusable, and here is why" precisely, instead of collapsing it into the
 * registry's generic failure text.
 */
export class StatementNotImportableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatementNotImportableError';
  }
}
