import type { McpTool } from './types';
import { UUID_RE, isRealCalendarDate } from '@/lib/validation';
import { MCP_INPUT_COMPATIBILITY } from './inputCompatibility';

export type ToolArgumentValidation = { ok: true; args: Record<string, unknown> } | { ok: false; message: string };
export const MCP_INPUT_SCHEMA_KEYWORDS = [
  'type', 'description', 'properties', 'additionalProperties', 'required', 'format',
  'enum', 'minimum', 'maximum', 'exclusiveMinimum', 'items', 'minItems', 'maxItems', 'maxLength',
] as const;
const keywords = new Set<string>(MCP_INPUT_SCHEMA_KEYWORDS);
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
type Schema = Record<string, unknown>;
const own = (object: object, key: PropertyKey): boolean => Object.hasOwn(object, key);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
class InputValidationError extends Error {}
function failure(path: string, reason: string): never { throw new InputValidationError(`${path || 'arguments'} ${reason}`); }

/** Reject values JSON would drop/coerce, and never invoke user-supplied getters. */
function inspectInput(args: Record<string, unknown>, write: boolean): void {
  const ancestors = new Set<object>();
  let nodes = 0;
  function visit(value: unknown, depth: number): void {
    if (++nodes > 100000 || depth > 64) failure('', 'exceed validation limits');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if ((!object(value) && !Array.isArray(value)) || ancestors.has(value)) failure('', 'must contain finite JSON values');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) failure('', 'contain an invalid array');
        for (let i = 0; i < value.length; i++) {
          const d = Object.getOwnPropertyDescriptor(value, String(i));
          if (!d?.enumerable || !own(d, 'value')) failure('', 'contain an invalid array');
          visit(d.value, depth + 1);
        }
      } else {
        for (const key of Reflect.ownKeys(value)) {
          const d = Object.getOwnPropertyDescriptor(value, key)!;
          if (typeof key !== 'string' || !d.enumerable || !own(d, 'value')) failure('', 'contain unsupported properties');
          if (depth === 0 && write && key === 'company_id' && d.value === undefined) continue;
          visit(d.value, depth + 1);
        }
      }
    } finally { ancestors.delete(value); }
  }
  visit(args, 0);
}

/** Check the entire schema, including optional branches, before accepting input. */
function inspectSchema(schema: Schema, depth = 0): void {
  if (depth > 64 || !object(schema)) failure('', 'use an unsupported tool schema');
  for (const key of Object.keys(schema)) if (!keywords.has(key)) failure('', 'use an unsupported tool schema');
  const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!declared.length || declared.some(t => typeof t !== 'string' || !types.has(t))) failure('', 'use an unsupported tool schema');
  if (schema.format !== undefined && schema.format !== 'date') failure('', 'use an unsupported tool format');
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(k => typeof k !== 'string'))) failure('', 'use an invalid required schema');
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.some(v => v !== null && !['string', 'number', 'boolean'].includes(typeof v)))) failure('', 'use an unsupported enum schema');
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'minItems', 'maxItems', 'maxLength']) {
    if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) failure('', 'use an invalid bound schema');
  }
  if (declared.includes('object')) {
    if (!object(schema.properties) || schema.additionalProperties !== false) failure('', 'use an unsupported object schema');
    for (const child of Object.values(schema.properties)) {
      if (!object(child)) failure('', 'use an invalid property schema');
      inspectSchema(child, depth + 1);
    }
  }
  if (declared.includes('array')) {
    if (!object(schema.items)) failure('', 'use an unsupported array schema');
    inspectSchema(schema.items, depth + 1);
  }
}

/**
 * Pure schema/shape gate. Does not authenticate, check ownership, call handlers,
 * consume approvals or change raw args. Root registry owns those other fences.
 */
export function validateToolArguments(tool: McpTool, args: unknown): ToolArgumentValidation {
  try {
    if (!object(args)) failure('', 'must be an object');
    inspectInput(args, tool.write);
    inspectSchema(tool.inputSchema);
    const properties = tool.inputSchema.properties as Record<string, Schema>;
    if (own(args, 'dry_run') && !own(properties, 'dry_run')) failure('dry_run', 'is not supported by this tool');
    if (tool.write) {
      if (typeof args.idempotency_key !== 'string' || !args.idempotency_key.trim()) failure('idempotency_key', 'is required for write operations');
      if (args.company_id != null && (typeof args.company_id !== 'string' || !UUID_RE.test(args.company_id))) failure('company_id', 'must be a valid id');
    }
    const compatibility = own(MCP_INPUT_COMPATIBILITY, tool.name) ? MCP_INPUT_COMPATIBILITY[tool.name]! : {};
    function validate(schema: Schema, value: unknown, path: string, keyPath: string, depth: number): void {
      if (depth > 64) failure(path, 'exceeds validation limits');
      if (value === null && compatibility.nullable?.includes(keyPath)) return;
      const clamped = compatibility.clamped?.includes(keyPath) === true;
      const declared = Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
      let numeric = value;
      if (typeof value === 'string' && value.trim() && compatibility.numeric?.includes(keyPath)) numeric = Number(value);
      const matches = declared.some(type => {
        if (type === 'null') return value === null;
        if (type === 'object') return object(value);
        if (type === 'array') return Array.isArray(value);
        if (type === 'number' || type === 'integer') return typeof numeric === 'number' && Number.isFinite(numeric)
          && (type === 'number' || clamped || Number.isSafeInteger(numeric));
        return typeof value === type;
      });
      if (!matches) failure(path, `must match type ${declared.join(' or ')}`);
      if (Array.isArray(schema.enum) && !schema.enum.some(v => v === value)) failure(path, 'must match an allowed value');
      if (typeof value === 'string') {
        if (typeof schema.maxLength === 'number' && [...value].length > schema.maxLength) failure(path, 'exceeds maximum length');
        if (schema.format === 'date' && !isRealCalendarDate(value)) failure(path, 'must be a real YYYY-MM-DD date');
      }
      if (typeof numeric === 'number' && !clamped) {
        if (typeof schema.minimum === 'number' && numeric < schema.minimum) failure(path, 'is below minimum');
        if (typeof schema.maximum === 'number' && numeric > schema.maximum) failure(path, 'exceeds maximum');
        if (typeof schema.exclusiveMinimum === 'number' && numeric <= schema.exclusiveMinimum) failure(path, 'must exceed minimum');
      }
      if (Array.isArray(value)) {
        if (typeof schema.minItems === 'number' && value.length < schema.minItems) failure(path, 'has too few items');
        if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) failure(path, 'has too many items');
        value.forEach((item, i) => validate(schema.items as Schema, item, `${path}[${i}]`, `${keyPath}.*`, depth + 1));
      } else if (object(value)) {
        const props = schema.properties as Record<string, Schema>;
        for (const key of (schema.required ?? []) as string[]) if (!own(value, key)) failure(path ? `${path}.${key}` : key, 'is required');
        for (const [key, child] of Object.entries(value)) {
          if (depth === 0 && tool.write && key === 'company_id' && !own(props, key)) continue;
          if (!own(props, key)) failure(path, 'contain unsupported properties');
          validate(props[key]!, child, path ? `${path}.${key}` : key, keyPath ? `${keyPath}.${key}` : key, depth + 1);
        }
      }
    }
    validate(tool.inputSchema, args, '', '', 0);
    return { ok: true, args };
  } catch (error) {
    return { ok: false, message: error instanceof InputValidationError ? error.message : 'Invalid tool arguments' };
  }
}
