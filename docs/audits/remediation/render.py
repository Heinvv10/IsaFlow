"""Validate preserved inputs and render a local, standalone progress report."""
import hashlib
import html
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
backlog = json.loads((ROOT / 'backlog.json').read_text())
items = backlog['items']
assert {item['id'] for item in items if item['id'].startswith('K-')} == {f'K-{n:03}' for n in range(1, 282)}
assert len({item['id'] for item in items}) == len(items)
assert {i['id'] for i in items if not i['id'].startswith('K-')} == {'R-001', 'R-002', 'R-003'}
sources = backlog['sourceInventory']
assert len({source['id'] for source in sources}) == len(sources)
expected_sources = {f'A C{n}' for n in range(1, 22)} | {f'A H{n}' for n in range(1, 56)} | {f'B F{n:02}' for n in range(1, 55)}
assert {source['id'] for source in sources} == expected_sources
for source in sources:
    targets = source.get('canonicalItems', [source['canonicalItem']])
    assert targets and all(target in {i['id'] for i in items} for target in targets)
    for target in targets:
        assert source['id'] in next(i for i in items if i['id'] == target)['sourceIds']
for item in items:
    for source_id in item['sourceIds']:
        source = next(s for s in sources if s['id'] == source_id)
        assert item['id'] in source.get('canonicalItems', [source['canonicalItem']])
for entry in json.loads((ROOT / 'inputs.json').read_text()):
    assert hashlib.sha256((ROOT / entry['snapshot']).read_bytes()).hexdigest() == entry['sha256']
escape = html.escape
rows = '\n'.join(
    '<tr>' + ''.join(f'<td>{escape(str(value))}</td>' for value in
    (item['id'], item['status'], item['area'], item['claim'], ', '.join(item['sourceIds']))) + '</tr>'
    for item in items
)
counts = ', '.join(f'{count} {status}' for status, count in Counter(i['status'] for i in items).items())
(ROOT / 'index.html').write_text(f'''<!doctype html>
<html lang="en"><meta charset="utf-8"><title>IsaFlow remediation evidence</title>
<style>body{{font:16px system-ui;margin:2rem;max-width:1400px}}table{{border-collapse:collapse;width:100%}}td,th{{padding:.7rem;text-align:left;border-bottom:1px solid #ccc;vertical-align:top}}th{{background:#eee}}a{{color:#164d8c}}</style>
<h1>IsaFlow remediation evidence</h1>
<p>{escape(counts)}. Code verification and deployment are separate states; no deployment is authorized by this remediation task.</p>
<p>{escape(backlog['scopeNote'])}</p>
<p>Baseline: <code>{escape(backlog['baselineSha'])}</code></p>
<p><a href="backlog.json">Finding register</a> · <a href="inputs.json">Input hashes</a> · <a href="evidence/baseline-ci.log">Baseline CI output</a> · <a href="HANDOFF.md">Execution handoff</a></p>
<table><thead><tr><th>ID</th><th>Status</th><th>Area</th><th>Original claim (unvalidated)</th><th>Explicit aliases</th></tr></thead><tbody>{rows}</tbody></table></html>''')
print(f'Validated {len(items)} candidate IDs (281 original K), {len(sources)} numbered source IDs and all input hashes. Scope acceptance remains open; see reconciliation.md.')
