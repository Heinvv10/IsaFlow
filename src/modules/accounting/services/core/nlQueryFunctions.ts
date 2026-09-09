import { parse } from 'pgsql-ast-parser';

type Node = Record<string, unknown>;
const object = (value: unknown): value is Node =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Functions an NL query may call. Relation validation cannot see the SQL text
 * inside a string argument, so any function able to read a relation on its own
 * (query_to_xml, table_to_xml, xpath over those, lo_get, ...) bypasses the
 * relation allowlist. Only purely analytical functions are permitted.
 */
export const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  // aggregates
  'count', 'sum', 'avg', 'min', 'max', 'string_agg', 'array_agg', 'bool_and', 'bool_or',
  'every', 'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop', 'var_samp',
  'percentile_cont', 'percentile_disc', 'mode',
  // window
  'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile',
  'lag', 'lead', 'first_value', 'last_value', 'nth_value',
  // null handling / comparison
  'coalesce', 'nullif', 'greatest', 'least',
  // quantified comparison operators the parser represents as calls
  'any', 'all', 'some', 'exists',
  // maths
  'abs', 'round', 'ceil', 'ceiling', 'floor', 'trunc', 'sign', 'mod', 'power', 'sqrt',
  'exp', 'ln', 'log', 'div',
  // strings
  'lower', 'upper', 'initcap', 'length', 'char_length', 'character_length',
  'trim', 'ltrim', 'rtrim', 'btrim', 'concat', 'concat_ws', 'substring', 'substr',
  'left', 'right', 'replace', 'split_part', 'position', 'strpos', 'reverse',
  'starts_with', 'regexp_replace',
  // dates and conversion
  'now', 'date_trunc', 'date_part', 'age', 'to_char', 'to_number', 'to_date',
  'to_timestamp', 'make_date', 'make_interval', 'justify_days', 'justify_hours',
  'justify_interval',
]);

/** Bare keywords that read session or role state rather than tenant data. */
const FORBIDDEN_KEYWORD_NODES = new Set(['current_user', 'session_user', 'user', 'current_role', 'current_catalog', 'current_schema']);

/** Reject any function call that is schema-qualified or outside the analytical allowlist. */
export function validateQueryFunctions(sql: string): string | null {
  function walk(value: unknown): string | null {
    if (Array.isArray(value)) {
      for (const child of value) {
        const error = walk(child);
        if (error) return error;
      }
      return null;
    }
    if (!object(value)) return null;
    if (value.type === 'keyword' && typeof value.keyword === 'string'
      && FORBIDDEN_KEYWORD_NODES.has(value.keyword.toLowerCase())) {
      return `Keyword '${value.keyword}' not allowed`;
    }
    if (value.type === 'cast' && object(value.to) && typeof value.to.name === 'string'
      && /^reg[a-z]*$/i.test(value.to.name)) {
      return `Cast to '${value.to.name}' not allowed`;
    }
    if (value.type === 'call') {
      if (!object(value.function) || typeof value.function.name !== 'string') return 'Unnamed function';
      const { name, schema } = value.function;
      if (schema !== undefined) return 'Schema-qualified functions are not allowed';
      if (!ALLOWED_FUNCTIONS.has(name.toLowerCase())) return `Function '${name}' not allowed`;
    }
    for (const child of Object.values(value)) {
      const error = walk(child);
      if (error) return error;
    }
    return null;
  }
  try {
    return walk(parse(sql));
  } catch {
    return 'Unparseable SQL';
  }
}
