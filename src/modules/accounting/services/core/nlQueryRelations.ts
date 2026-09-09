import { parse } from 'pgsql-ast-parser';

type Node = Record<string, unknown>;
const object = (value: unknown): value is Node =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Validate physical relations, preserving lexical CTE visibility and identifier case. */
export function validateQueryRelations(sql: string, allowed: ReadonlySet<string>): string | null {
  function walk(value: unknown, ctes: ReadonlySet<string>): string | null {
    if (Array.isArray(value)) {
      for (const child of value) {
        const error = walk(child, ctes);
        if (error) return error;
      }
      return null;
    }
    if (!object(value)) return null;
    if (value.type === 'with') {
      if (!Array.isArray(value.bind)) return 'Unsupported WITH statement';
      const visible = new Set(ctes);
      for (const binding of value.bind) {
        if (!object(binding) || !object(binding.alias) || typeof binding.alias.name !== 'string') {
          return 'Unsupported CTE binding';
        }
        const error = walk(binding.statement, visible);
        if (error) return error;
        visible.add(binding.alias.name);
      }
      return walk(value.in, visible);
    }
    if (value.type === 'table') {
      if (!object(value.name) || typeof value.name.name !== 'string') return 'Unnamed table';
      const { name, schema } = value.name;
      if (schema !== undefined && schema !== 'public') return 'Table schema not allowed';
      if (!(schema === undefined && ctes.has(name)) && !allowed.has(name)) {
        return `Table '${name}' not allowed`;
      }
    }
    for (const child of Object.values(value)) {
      const error = walk(child, ctes);
      if (error) return error;
    }
    return null;
  }
  try {
    const statements = parse(sql);
    if (statements.length !== 1) return 'Exactly one statement is required';
    if (!['select', 'with'].includes(statements[0]!.type)) return 'Unsupported query statement';
    return walk(statements[0], new Set());
  } catch {
    return 'Unparseable SQL';
  }
}
