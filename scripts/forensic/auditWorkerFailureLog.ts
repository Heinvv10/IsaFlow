/** Sanitizes an audit worker failure into loggable data: error class/name and a
 * scrubbed message only. Never a raw stack (env/argv can be attached to it) and
 * never a connection-string-shaped substring (host, credentials, DSN). */
const CONNECTION_STRING_RE = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;

export function sanitizeAuditWorkerFailure(error: unknown): { name: string; message?: string } {
  if (!(error instanceof Error)) return { name: typeof error };
  return { name: error.constructor.name, message: error.message.replace(CONNECTION_STRING_RE, '[redacted]') };
}
