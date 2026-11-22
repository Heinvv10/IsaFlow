/** What the CLI says when the run stops on an error. After --live the run may already have committed: it says so, and what to do. PURE. */
export function stopMessage(err: unknown, live: boolean): string {
  const why = `sage migration stopped: ${err instanceof Error ? err.message : String(err)}`;
  return live
    ? `${why}\nthe live run may already have committed some batches before this error: check the books (or run again without --live: a dry run lists what is there and what differs); a re-run resumes.`
    : why;
}
