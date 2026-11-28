/**
 * The Sage migration's reader of thrown values (rounds 36-39): the generic core (`told`, `codeOf`, `snapshot`, OwnError...) lives in
 * src/lib/thrownValue.ts with no driver import (R39r-5); this module adds what is pg's: whether a snapshot was made from the server's own
 * answer (a pg.DatabaseError), so 57P01, 55P03, 57014 and a deferred refusal classify as before. Every module of the migration and its
 * CLI imports from here. A census test refuses a bare read in either tree (sageToldCensus.test.ts).
 */
import pg from 'pg';
import { causeOf, codeOf, commandOf, once, OwnError, severityOf, snapshot as coreSnapshot, told } from '@/lib/thrownValue';

export { causeOf, codeOf, commandOf, OwnError, severityOf, told };

/** For a snapshot: whether the value it was made from was the server's answer (a pg.DatabaseError). */
const SERVER = new WeakSet<object>();
const ServerError = (pg as { DatabaseError?: abstract new (...a: never[]) => Error }).DatabaseError;
const markServer = (raw: unknown, snap: Error): void => {
  if (typeof ServerError === 'function' && once(() => raw instanceof ServerError) === true) SERVER.add(snap);
};

/** A foreign value as our own frozen Error (thrownValue.ts), marked when it was the server's answer. Our own errors as they are. */
export const snapshot = (raw: unknown): Error => coreSnapshot(raw, markServer);

/** Whether a snapshot (or a value, snapshotted first) was the server's own answer (a pg.DatabaseError). */
export const fromServer = (err: unknown): boolean => SERVER.has(snapshot(err));

/** A thrown value made safe where it enters: ours as it is, anything else its snapshot (never the foreign value itself). */
export const safeThrown = (raw: unknown): Error => snapshot(raw);

/** A thrown value as an Error the code can read and keep: the same as safeThrown. */
export const asError = (err: unknown): Error => snapshot(err);
