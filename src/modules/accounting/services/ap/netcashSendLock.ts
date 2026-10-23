/**
 * The Netcash send lock (AP-01 round 10): proof that a claim's sender is still alive.
 *
 * The sender takes a SESSION advisory lock on its claim, on the connection that claims, settles and then unlocks
 * (services/ap/netcashSubmissionClaim). It is taken inside the claim's transaction, before the claim commits, so no
 * one can see a 'pending' row whose sender does not hold it yet; it is released after the settle commits, and it
 * goes with the connection if the process or the connection dies. netcash/resolve takes the same key with
 * pg_try_advisory_xact_lock and refuses 409 IN_FLIGHT while it is held - a stalled or paused sender keeps its claim
 * however old it is.
 *
 * The key is the TWO-int4 form (classid, objid): Postgres keeps it apart from the single-bigint form every other
 * advisory lock in this repo uses (hashtext/hashtextextended keys, the migration runner's constant), so they cannot
 * collide. Two claim ids whose hashtext collides only make a resolve wait for an unrelated send (a 409, never a
 * release). The claim id is cast ::UUID::TEXT on both sides so the key does not depend on the id's letter case.
 */

/** classid of the send lock: 'NCSD' (0x4E435344). */
export const NETCASH_SEND_LOCK_CLASS = 0x4e435344;
