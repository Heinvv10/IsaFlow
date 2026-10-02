/**
 * The attributes a print page sets on <html> when it can never become ready.
 * One per producer, all starting with this prefix — see `markPrintError` in
 * `usePrintMode.ts`. Its own module, with no imports, so the print page (a
 * browser bundle) and the transports (Node) share the name without either
 * pulling in the other's dependencies.
 */
export const PRINT_ERROR_ATTRIBUTE_PREFIX = 'data-print-error';
