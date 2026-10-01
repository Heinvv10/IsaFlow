/**
 * A chart-of-accounts write refused by a business rule: the account does not
 * exist, holds money, is a system account, would double a role. The message is
 * written for the user and nothing has been written when it is thrown.
 *
 * A CLASS, so routes can tell a refusal from a failure by what it IS. They used
 * to treat any Error without a `code` as a refusal — but node-postgres raises
 * exactly that for "Connection terminated unexpectedly" and "Query read
 * timeout", so a dropped connection was answered 400 with the driver's message,
 * and `withAuth` COMMITS below 500.
 */
export class ChartRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChartRefusal';
  }
}
