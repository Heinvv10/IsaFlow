/**
 * Maps what the receiver's own document services throw while building a draft from a message onto the answers the inbox gives:
 * a duplicate (the database's unique supplier + number index) and the services' own validation sentences become refusals a person
 * reads; anything else (a bug, a lost connection) is rethrown untouched so it is a 5xx and rolls the request back.
 */
import { ConnectionRefusal } from './connectionTypes';

const isDbError = (err: unknown): err is { code: string; constraint?: string } =>
  typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string' && /^[0-9A-Z]{5}$/.test((err as { code: string }).code);

export function mapDraftError(err: unknown): unknown {
  if (err instanceof ConnectionRefusal) return err;
  if (isDbError(err) && err.code === '23505') {
    return new ConnectionRefusal(409, 'A bill with this number already exists for this supplier.', true);
  }
  if (isDbError(err)) return err;
  // The services' validation errors are plain Errors with a sentence meant for a person (an account that cannot be used, a line
  // that does not add up); a TypeError or any other class is a defect and stays one.
  if (err instanceof Error && err.constructor === Error) return new ConnectionRefusal(400, err.message.slice(0, 300));
  const named = err as { name?: string; message?: string; code?: string } | null;
  if (named && typeof named.message === 'string' && (named.code?.endsWith('_REFUSED') || named.name?.endsWith('Refusal') || named.name === 'CreditNoteLinkError')) {
    return new ConnectionRefusal(400, named.message.slice(0, 300));
  }
  return err;
}
