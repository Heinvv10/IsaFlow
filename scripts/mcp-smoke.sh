#!/usr/bin/env bash
# Live JSON-RPC smoke test for the IsaFlow MCP connector.
#
# Usage: ISAFLOW_MCP_TOKEN=pat_xxx bash scripts/mcp-smoke.sh https://dev-host
#
# Verifies (against a running host):
#   1. OAuth discovery document is served
#   2. authenticated initialize returns the isaflow server
#   3. authenticated tools/list exposes a known tool
#   4. an UNAUTHENTICATED tools/call is rejected 401 (Bearer challenge)
#   5. a GET asking for an SSE stream is 405 (Streamable HTTP: SSE or 405)
# Read-only: no step writes anything.
# Exits non-zero on the first failure (set -e).
set -euo pipefail

BASE="${1:?usage: ISAFLOW_MCP_TOKEN=pat_xxx bash scripts/mcp-smoke.sh <base-url>}"
BASE="${BASE%/}" # tolerate a trailing slash in the host argument
AUTH="Authorization: Bearer ${ISAFLOW_MCP_TOKEN:?ISAFLOW_MCP_TOKEN env var required}"
CT='Content-Type: application/json'

# Steps 2-3 fail (via pipefail) if the token's company lacks the mcp_connector
# flag — the endpoint returns a JSON-RPC error envelope, not result. If those
# steps fail, first check the flag is enabled for the smoke company.

echo "1/5 OAuth discovery…"
curl -sf "$BASE/.well-known/oauth-authorization-server" | grep -q authorization_endpoint

echo "2/5 initialize (authenticated)…"
curl -sf -X POST "$BASE/api/mcp" -H "$AUTH" -H "$CT" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | grep -q '"isaflow"'

echo "3/5 tools/list (authenticated)…"
curl -sf -X POST "$BASE/api/mcp" -H "$AUTH" -H "$CT" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | grep -q trial_balance

echo "4/5 unauthenticated tools/call → 401…"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/mcp" -H "$CT" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"trial_balance"}}')"
[ "$code" = "401" ] || { echo "  expected 401, got $code"; exit 1; }

echo "5/5 GET with Accept: text/event-stream → 405…"
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/mcp" -H 'Accept: text/event-stream')"
[ "$code" = "405" ] || { echo "  expected 405, got $code"; exit 1; }

echo "MCP smoke OK"
