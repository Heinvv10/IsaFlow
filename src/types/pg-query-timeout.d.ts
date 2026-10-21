/**
 * node-postgres reads a per-query `query_timeout` from the query config (pg/lib/client.js), but @types/pg's
 * QueryConfig does not declare it. Declared here so a bounded query can be written as a plain config literal
 * (the R-176 rollback census reads a config's `text` only when it is not hidden behind a cast).
 */
import 'pg';

declare module 'pg' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the type parameter must match pg's declaration to merge
  interface QueryConfig<I> {
    query_timeout?: number | undefined;
  }
}
