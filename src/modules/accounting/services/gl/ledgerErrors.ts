/** The account asked for does not exist for this company (missing and another company's look identical). */
export class LedgerAccountNotFoundError extends Error {
  constructor(identifier: string) {
    super(`Account ${identifier} not found for this company`);
    this.name = 'LedgerAccountNotFoundError';
  }
}
