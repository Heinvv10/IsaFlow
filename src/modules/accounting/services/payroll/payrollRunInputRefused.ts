import { TransactionRefusal } from '@/lib/transactionRefusal';

/** Raised before the first write, or inside the savepoint that undoes it, so answering it as a 4xx commits nothing. */
export class PayrollRunInputRefusedError extends TransactionRefusal {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'PayrollRunInputRefusedError';
    this.status = status;
  }
}
