"""
Shared ISAFlow API client for the Velocity Fibre phase-3 scripts.

PRD-10 Layer 3: scripts authenticate with a Personal Access Token (PAT)
instead of scraping the user's Chrome cookies. Mint a PAT at
  https://app.isaflow.co.za/developer/personal-tokens
and export it before running:
  export ISAFLOW_PAT=pat_xxxxxxxxxxxx
  export ISAFLOW_COMPANY_ID=<uuid>     # optional override; PAT is already
                                       # company-scoped server-side
  export ISAFLOW_BASE=https://app.isaflow.co.za   # optional, default prod
"""
import json
import os
import urllib.request
import urllib.error

UA = "isaflow-velocity-script/1.0"


def _config():
    pat = os.environ.get("ISAFLOW_PAT")
    if not pat:
        raise SystemExit(
            "ISAFLOW_PAT not set. Mint one at /developer/personal-tokens, then "
            "export ISAFLOW_PAT=pat_..."
        )
    base = os.environ.get("ISAFLOW_BASE", "https://app.isaflow.co.za").rstrip("/")
    company_id = os.environ.get("ISAFLOW_COMPANY_ID")  # optional
    return pat, base, company_id


def _headers(pat, company_id, content_type=None):
    h = {"Authorization": f"Bearer {pat}", "User-Agent": UA}
    if company_id:
        h["X-Company-Id"] = company_id
    if content_type:
        h["Content-Type"] = content_type
    return h


def base_url():
    _, base, _ = _config()
    return base


def get(path, timeout=30):
    pat, base, company_id = _config()
    url = path if path.startswith("http") else f"{base}{path}"
    req = urllib.request.Request(url, headers=_headers(pat, company_id))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def post(path, payload, timeout=60):
    pat, base, company_id = _config()
    url = path if path.startswith("http") else f"{base}{path}"
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers=_headers(pat, company_id, "application/json"),
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            data = json.loads(e.read())
        except Exception:  # noqa: BLE001 — best-effort error decode
            data = {"error": {"message": str(e)}}
        return e.code, data
