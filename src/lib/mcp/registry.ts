/**
 * MCP tool registry — the security fence for every tools/call.
 *
 * call() order is the invariant (proven by tests, not convention):
 *   resolve tool → scope check → write:post check → idempotency-key presence
 *   → replay lookup → handler → audit.
 * Rejections happen BEFORE the handler runs and are audited as 'rejected'.
 * Handler errors return a GENERIC message — never stack traces or SQL.
 */
import { withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { McpTool, McpToolContext, McpToolResult } from './types';
import { acquireIdempotencyLock, findIdempotentReplay, hashArgs, recordToolCall } from './audit';
import { debitForTool, refundForTool } from './flowMetering';
import { BulkAllocationLineError, bulkAllocationLineErrorText } from './bulkAllocationLineError';

/**
 * The SAVEPOINT name a write tool runs under.
 *
 * withSavepoint validates against /^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/ and THROWS
 * otherwise — 31 characters total. `mcp_bulk_allocate_bank_transactions` is 35,
 * so the naive `mcp_${name}` threw before the handler ever ran and every call
 * came back as GENERIC_FAILURE with nothing pointing at the tool name.
 * Truncating keeps the prefix traceable; registrySavepointName.test.ts asserts
 * the truncated names stay distinct, which is what stops one tool releasing
 * another's savepoint.
 */
import { COMPANY_ASSERT_PROPERTY, assertCompanyMatches } from './companyAssert';

export function savepointNameFor(toolName: string): string {
  return `mcp_${toolName}`.slice(0, 31);
}

function errorResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const GENERIC_FAILURE = 'The operation failed. Please try again or contact support.';

export class McpRegistry {
  private tools = new Map<string, McpTool>();

  register(tool: McpTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`McpRegistry: duplicate tool name "${tool.name}"`);
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * The optional `company_id` assertion is injected HERE rather than written
   * into each tool's schema, so a new write tool cannot ship without it. It is
   * a guard, never a selector — see companyAssert.ts.
   */
  getManifest(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.write ? withCompanyAssert(t.inputSchema) : t.inputSchema,
    }));
  }

  /** Full tool records — used by manifest/security suite tests, not clients. */
  listTools(): McpTool[] {
    return [...this.tools.values()];
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    ctx: McpToolContext,
  ): Promise<McpToolResult> {
    const started = Date.now();
    const argsHash = hashArgs(args);

    const reject = async (text: string, idempotencyKey: string | null): Promise<McpToolResult> => {
      await recordToolCall({
        ctx, tool: name, argsHash, idempotencyKey,
        status: 'rejected', result: null, durationMs: Date.now() - started,
      });
      return errorResult(text);
    };

    const tool = this.tools.get(name);
    if (!tool) return reject(`Unknown tool: ${name}`, null);

    if (tool.scope && !ctx.scopes.includes(tool.scope)) {
      return reject(`Insufficient scope: this tool requires ${tool.scope}`, null);
    }

    if (tool.requiresPost && !ctx.scopes.includes('write:post')) {
      return reject(
        'This operation posts irreversible entries and requires the write:post permission, which this connection was not granted.',
        null,
      );
    }

    // Assert-only company guard. Runs before the idempotency-key check so a
    // mismatch never burns a key, and before any handler so nothing is
    // written. Applied to writes only: a read against the wrong company
    // returns that company's data, which is visible and self-correcting,
    // whereas a write is not.
    if (tool.write) {
      const mismatch = assertCompanyMatches(args, ctx.companyId);
      if (mismatch) return reject(mismatch.content[0]!.text, null);
    }

    const rawKey = args.idempotency_key;
    const idempotencyKey =
      typeof rawKey === 'string' && rawKey.trim() ? rawKey.trim() : null;

    if (tool.write && !idempotencyKey) {
      return reject('idempotency_key is required for write operations', null);
    }

    if (tool.write && idempotencyKey) {
      // Serialise concurrent same-key calls BEFORE the replay-check so two
      // racing writes can't both pass "no prior call" and double-post. The
      // lock is held for the request tx and released on COMMIT/ROLLBACK.
      await acquireIdempotencyLock(ctx.companyId, name, idempotencyKey);
      const replay = await findIdempotentReplay(ctx.companyId, name, idempotencyKey, argsHash);
      if (replay.status === 'match') {
        log.info('MCP: idempotent replay served', { tool: name, companyId: ctx.companyId }, 'mcp');
        // Stored results may carry registry-internal flags (billable) — strip on replay too.
        const { billable: _b, wroteNothing: _w, ...replayWire } = replay.result;
        return replayWire;
      }
      if (replay.status === 'conflict') {
        // Same key, different args — refuse rather than serve the stale result.
        return reject(
          'idempotency_key was already used for a different request. Use a fresh key.',
          idempotencyKey,
        );
      }
    }

    // Data minimisation: only write tools need the stored result (for
    // idempotent replay). Reads never replay, so persisting their payload
    // would be a second at-rest copy of financial data with no use.
    const runAndAudit = async (): Promise<McpToolResult> => {
      const result = await tool.handler(args, ctx);
      // A handler REFUSAL is audited as 'rejected' with a NULL key, never as a
      // replayable 'ok'. Same reasoning as the insufficient-Flows and
      // handler-throw paths below: the partial unique index is
      // (company_id, tool, idempotency_key) with no status column and
      // recordToolCall does ON CONFLICT DO NOTHING, so a row carrying the real
      // key permanently occupies that slot.
      //
      // Stored under the key instead, a refusal replays FOREVER. Most of these
      // refusals are state-dependent, not argument-dependent — "Not found" for
      // a batch that had not committed yet, "Transaction already allocated",
      // an ownership check racing a customer being created. Once the state is
      // fixed the identical call is still correct, and the agent (which chose
      // one key per logical operation) would get the stale error back with no
      // way to tell it apart from a fresh one. Nothing is lost by re-running:
      // a refusal wrote nothing, so there is no duplicate to protect against.
      const refused = result.isError === true;
      // A success that wrote nothing (a dry run) must not occupy the key
      // either: the real call that follows carries the same intent and the same
      // natural key, and would otherwise be served the dry run's "posted: 0"
      // forever. Handlers set this ONLY when nothing was written.
      const keyFree = refused || result.wroteNothing === true;
      await recordToolCall({
        ctx, tool: name, argsHash,
        idempotencyKey: keyFree ? null : idempotencyKey,
        status: refused ? 'rejected' : 'ok',
        result: tool.write && !keyFree ? result : null,
        durationMs: Date.now() - started,
      });
      return result;
    };

    // PAYG debit. Deliberately OUTSIDE the savepoint below: a debit taken
    // inside it is rolled back automatically when a write tool throws, and the
    // explicit refund on that same path would then credit the company twice.
    // Also deliberately AFTER the replay check — a retried idempotent call
    // returns the stored result without re-running the handler, so charging it
    // again would bill twice for one operation.
    const debit = await debitForTool(ctx.companyId, name, args);
    if (!debit.ok) {
      // Audited WITHOUT the idempotency key, deliberately. The partial unique
      // index is (company_id, tool, idempotency_key) with no status column, and
      // recordToolCall does ON CONFLICT DO NOTHING — so a 'rejected' row here
      // would permanently occupy the key. The later successful call's 'ok' row
      // would be silently dropped, and findIdempotentReplay (which matches only
      // status='ok') would never see it again: every retry of that key would
      // re-run the handler, creating duplicate documents and duplicate debits.
      // Running out of Flows must not burn the key.
      return reject(
        `Insufficient Flows: ${name} costs ${debit.required} and the wallet holds ${debit.balance}. Top up to continue.`,
        null,
      );
    }

    try {
      // Write tools run inside a SAVEPOINT: the registry catches a handler
      // throw and returns a 200 isError envelope (MCP protocol), so the
      // transport's pipeline never sees a 5xx and would otherwise COMMIT any
      // partial write the service made before throwing. The savepoint rolls
      // that partial write back — matching the REST route's rollback-on-throw
      // (the audit 'error' below runs OUTSIDE it, on the surviving request tx).
      const result = tool.write
        ? await withSavepoint(savepointNameFor(name), runAndAudit)
        : await runAndAudit();

      // Refund when the call cost the company nothing worth billing: an error,
      // or a success that did no billable work (`billable: false` — e.g. a
      // statement resend where every row was already imported). Neither throws,
      // so the savepoint does not roll back and this is the only place the
      // debit can be undone.
      const didBillableWork = result.isError !== true && result.billable !== false;
      if (!didBillableWork && debit.handle) {
        await refundForTool(ctx.companyId, debit.handle);
      }
      // Both flags are registry-internal — never put them on the wire.
      const { billable: _billable, wroteNothing: _wroteNothing, ...wire } = result;
      return wire;
    } catch (err) {
      log.error(
        'MCP tool handler failed',
        { tool: name, companyId: ctx.companyId, err: err instanceof Error ? err.message : String(err) },
        'mcp',
      );
      if (debit.handle) await refundForTool(ctx.companyId, debit.handle);
      // Audited WITHOUT the idempotency key — same reasoning as the
      // insufficient-Flows reject above. The partial unique index is
      // (company_id, tool, idempotency_key) and recordToolCall does
      // ON CONFLICT DO NOTHING, so an 'error' row carrying the real key
      // permanently occupies that slot: the retry's successful 'ok' row is
      // silently dropped, and because findIdempotentReplay matches only
      // status='ok', every later retry of that key re-runs the handler instead
      // of replaying. A failed call must not burn the key.
      //
      // This became reachable for finalize_invoice once it stopped swallowing
      // its GL failures (a swallowed error returned an isError envelope and
      // never reached this catch at all).
      await recordToolCall({
        ctx, tool: name, argsHash, idempotencyKey: null,
        status: 'error', result: null, durationMs: Date.now() - started,
      });
      // A BATCH tool that failed on one identifiable line is the one case where
      // GENERIC_FAILURE is the wrong answer. "The operation failed" tells an
      // agent holding 124 lines nothing it can act on — the pilot bisected such
      // a batch by hand. The line index and its transaction id are the agent's
      // OWN input, so naming them leaks nothing, and the message the tool built
      // is already free of SQL and stack. Everything else about this path is
      // unchanged: rolled back by the savepoint, refunded, audited 'error' with
      // a NULL key so the retry is not burned.
      if (err instanceof BulkAllocationLineError) {
        return errorResult(bulkAllocationLineErrorText(name, err));
      }
      return errorResult(GENERIC_FAILURE);
    }
  }
}

/**
 * Add the optional `company_id` assertion to a write tool's schema without
 * mutating the tool's own object (the manifest is rebuilt per request, and the
 * tool records are shared).
 */
function withCompanyAssert(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  // A tool that already declares company_id keeps its own definition — nothing
  // does today, and the drift test asserts none starts.
  if ('company_id' in properties) return schema;
  return { ...schema, properties: { ...properties, ...COMPANY_ASSERT_PROPERTY } };
}
