#!/usr/bin/env python3
"""
Ingest FibreFlow knowledge documents into Qdrant vector database.

Usage:
  python3 scripts/ingest-qdrant.py             # Incremental (skip existing sources)
  python3 scripts/ingest-qdrant.py --force      # Re-ingest all sources
  python3 scripts/ingest-qdrant.py --source docs/INFRASTRUCTURE.md  # Single file
  python3 scripts/ingest-qdrant.py --dry-run    # Count chunks without embedding

Uses local Ollama nomic-embed-text (768-dim) for embeddings.
Reads .env.local for DATABASE_URL (schema ingestion).
Connects to Qdrant at localhost:6333 and GPU embed-server at localhost:11437 (must run on Velocity).

Safety guards (ported from Ironman reindex-qdrant.py):
- Lockfile prevents concurrent instances
- Memory headroom check refuses to start if system is low on RAM
- RSS limit kills the process if it exceeds 16GB
- Chunk truncation for embedding input
- Dimension validation on every vector
"""

import argparse
import fcntl
import gc
import hashlib
import os
import re
import resource
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Concurrency lock — only one ingestion at a time to prevent OOM
# ---------------------------------------------------------------------------

LOCK_PATH = "/tmp/reindex-qdrant.lock"
_lock_fd = open(LOCK_PATH, "w")
try:
    fcntl.flock(_lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    print("ERROR: Another qdrant indexing process is already running. Exiting.")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Memory headroom check — refuse to start if system is low on RAM
# ---------------------------------------------------------------------------

try:
    with open("/proc/meminfo") as f:
        meminfo = {line.split(":")[0]: int(line.split()[1]) for line in f if len(line.split()) >= 2}
    avail_gb = meminfo.get("MemAvailable", 0) / (1024 * 1024)
    MIN_HEADROOM_GB = 8
    if avail_gb < MIN_HEADROOM_GB:
        print(f"ERROR: Only {avail_gb:.1f}GB available (minimum {MIN_HEADROOM_GB}GB required). Exiting to protect system stability.")
        sys.exit(1)
    print(f"Memory check: {avail_gb:.1f}GB available (minimum {MIN_HEADROOM_GB}GB)")
except Exception as e:
    print(f"Warning: Could not check available memory: {e}")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

COLLECTION = "isaflow_kb"
# Velo hosts Qdrant on 0.0.0.0:6333 (Tailscale 100.96.203.105) + Ollama on
# 127.0.0.1:11434 (loopback only — needs SSH tunnel from this machine).
# Defaults work when running on velo itself; override via env from a dev box:
#   export QDRANT_HOST=100.96.203.105
#   ssh -f -N -L 11434:localhost:11434 velo@100.96.203.105
QDRANT_HOST = os.environ.get("QDRANT_HOST", "localhost")
QDRANT_PORT = int(os.environ.get("QDRANT_PORT", "6333"))
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434/v1/embeddings")
EMBEDDING_MODEL = "nomic-embed-text"
EMBEDDING_DIM = 768
CHUNK_SIZE = 800          # max words per chunk
MAX_EMBED_CHARS = 3200    # truncate text sent to Ollama (nomic context ~8k tokens)
MAX_PAYLOAD_CHARS = 3000  # truncate content stored in payload
RSS_LIMIT_MB = 16000      # kill if RSS exceeds this

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# Env loading
# ---------------------------------------------------------------------------

def load_env():
    """Load .env.local and .env into os.environ (first wins)."""
    for name in (".env.local", ".env"):
        env_file = PROJECT_ROOT / name
        if not env_file.exists():
            continue
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                m = re.match(r"^([^#=]+)=(.*)$", line)
                if m:
                    key, val = m.group(1).strip(), m.group(2).strip()
                    if key not in os.environ:
                        os.environ[key] = val

# ---------------------------------------------------------------------------
# Source discovery
# ---------------------------------------------------------------------------

SOURCE_GLOBS = [
    ("docs/*.md",                                       "docs"),
    ("docs/prd/*.md",                                   "prd"),
    ("CLAUDE.md",                                       "root-claude"),
    (".claude/commands/*.md",                           "claude-commands"),
    ("src/lib/*.claude.md",                             "lib-context"),
    ("src/modules/accounting/services/**/.claude.md",   "service-group-context"),
    ("pages/api/accounting/**/.claude.md",              "api-group-context"),
]


def discover_sources(single_source=None):
    """Return list of (source_id, file_path) tuples."""
    sources = []
    if single_source:
        p = PROJECT_ROOT / single_source
        if not p.exists():
            print(f"  File not found: {single_source}")
            sys.exit(1)
        sources.append((single_source, p))
        return sources

    for pattern, _tag in SOURCE_GLOBS:
        for p in sorted(PROJECT_ROOT.glob(pattern)):
            if p.name == "README.md":
                continue
            rel = str(p.relative_to(PROJECT_ROOT))
            sources.append((rel, p))

    return sources

# ---------------------------------------------------------------------------
# Chunking (mirrors old ingest-knowledge.js strategy)
# ---------------------------------------------------------------------------

def chunk_markdown(text, source_id):
    """Split markdown by ## headings, then sub-chunk large sections."""
    chunks = []
    sections = re.split(r"(?=^## )", text, flags=re.MULTILINE)

    for section in sections:
        heading_match = re.match(r"^##+ (.+)", section, re.MULTILINE)
        section_title = heading_match.group(1).strip() if heading_match else "Introduction"

        # Strip image markdown
        cleaned = re.sub(r"!\[.*?\]\(.*?\)\n?\*.*?\*\n?", "", section)
        cleaned = re.sub(r"!\[.*?\]\(.*?\)", "", cleaned).strip()

        if not cleaned or len(cleaned) < 20:
            continue

        words = cleaned.split()
        if len(words) <= CHUNK_SIZE:
            chunks.append({
                "content": cleaned,
                "section": section_title,
                "source": source_id,
            })
            continue

        # Sub-chunk by paragraphs with overlap
        paragraphs = re.split(r"\n\n+", cleaned)
        current, current_wc, part = [], 0, 0

        for para in paragraphs:
            pw = len(para.split())
            if current_wc + pw > CHUNK_SIZE and current:
                chunks.append({
                    "content": "\n\n".join(current),
                    "section": f"{section_title} (part {part + 1})",
                    "source": source_id,
                })
                part += 1
                # Overlap: keep last paragraph
                last = current[-1]
                current = [last]
                current_wc = len(last.split())

            current.append(para)
            current_wc += pw

        if current:
            label = f"{section_title} (part {part + 1})" if part > 0 else section_title
            chunks.append({
                "content": "\n\n".join(current),
                "section": label,
                "source": source_id,
            })

    return chunks

# ---------------------------------------------------------------------------
# DB schema ingestion
# ---------------------------------------------------------------------------

def fetch_db_schema():
    """Fetch table/column info from Neon and return chunks."""
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("  No DATABASE_URL — skipping DB schema ingestion")
        return []

    try:
        import psycopg2
    except ImportError:
        print("  psycopg2 not installed — skipping DB schema ingestion")
        return []

    conn = psycopg2.connect(db_url)
    cur = conn.cursor()
    cur.execute("""
        SELECT t.table_name,
               string_agg(c.column_name || ' ' || c.data_type,
                          ', ' ORDER BY c.ordinal_position) AS columns
        FROM information_schema.tables t
        JOIN information_schema.columns c
          ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE t.table_schema = 'public'
          AND t.table_type IN ('BASE TABLE', 'VIEW')
        GROUP BY t.table_name
        ORDER BY t.table_name
    """)
    rows = cur.fetchall()
    cur.close()
    conn.close()

    chunks, current, current_wc = [], [], 0
    for table_name, columns in rows:
        entry = f"{table_name}: {columns}"
        ew = len(entry.split())
        if current_wc + ew > CHUNK_SIZE and current:
            chunks.append({
                "content": "DATABASE SCHEMA:\n" + "\n\n".join(current),
                "section": f"DB Schema ({len(current)} tables)",
                "source": "db-schema",
            })
            current, current_wc = [], 0
        current.append(entry)
        current_wc += ew

    if current:
        chunks.append({
            "content": "DATABASE SCHEMA:\n" + "\n\n".join(current),
            "section": f"DB Schema ({len(current)} tables)",
            "source": "db-schema",
        })

    print(f"  {len(rows)} tables -> {len(chunks)} schema chunks")
    return chunks

# ---------------------------------------------------------------------------
# Embedding — local Ollama nomic-embed-text (768-dim)
# ---------------------------------------------------------------------------

EMBED_BATCH_SIZE = 20  # batch size for GPU embed-server


def embed_texts(texts):
    """Embed texts via local GPU embed-server (OpenAI-compatible API). Returns list of (index, vector) tuples."""
    import urllib.request
    import json

    results = []

    for i in range(0, len(texts), EMBED_BATCH_SIZE):
        batch = [t[:MAX_EMBED_CHARS] for t in texts[i : i + EMBED_BATCH_SIZE]]
        batch = [t for t in batch if len(t) >= 10]
        if not batch:
            continue

        body = json.dumps({"model": EMBEDDING_MODEL, "input": batch}).encode()

        data = None
        for attempt in range(5):
            req = urllib.request.Request(
                OLLAMA_URL,
                data=body,
                headers={"Content-Type": "application/json"},
            )
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    data = json.loads(resp.read())
                break
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ConnectionResetError, OSError) as e:
                wait = 2 ** attempt
                print(f"    Embed error (attempt {attempt+1}/5): {e} — retrying in {wait}s")
                time.sleep(wait)

        if data is None:
            print(f"    WARNING: Batch at index {i} failed after 5 retries. Skipping {len(batch)} chunks.")
            continue

        for item in data["data"]:
            vec = item["embedding"]
            idx = i + item["index"]
            # Guardrail: validate dimension
            if len(vec) != EMBEDDING_DIM:
                print(f"    WARNING: Got {len(vec)}-dim vector, expected {EMBEDDING_DIM}. Skipping.")
                continue
            results.append((idx, vec))

        done = min(i + EMBED_BATCH_SIZE, len(texts))
        if done % 50 == 0 and done < len(texts):
            print(f"    Embedded {done}/{len(texts)} chunks...")

    return results

# ---------------------------------------------------------------------------
# Deterministic point IDs
# ---------------------------------------------------------------------------

def point_id(source, chunk_index):
    """Deterministic int64 ID from source + chunk_index (so re-runs upsert, not duplicate)."""
    h = hashlib.sha256(f"{source}::{chunk_index}".encode()).hexdigest()
    return int(h[:15], 16)  # 60-bit int, fits Qdrant u64

# ---------------------------------------------------------------------------
# RSS check
# ---------------------------------------------------------------------------

def check_rss():
    """Kill process if RSS exceeds limit."""
    rss_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    if rss_mb > RSS_LIMIT_MB:
        print(f"\nERROR: RSS exceeded {RSS_LIMIT_MB}MB ({rss_mb:.0f}MB). Exiting to protect system.")
        sys.exit(1)
    return rss_mb

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Ingest FibreFlow KB into Qdrant")
    parser.add_argument("--force", action="store_true", help="Re-ingest all sources")
    parser.add_argument("--source", type=str, help="Ingest single file (relative path)")
    parser.add_argument("--dry-run", action="store_true", help="Count chunks only")
    args = parser.parse_args()

    load_env()

    from qdrant_client import QdrantClient
    from qdrant_client.models import (
        PointStruct, Distance, VectorParams,
        FilterSelector, Filter, FieldCondition, MatchValue,
    )

    client = QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT)

    # Ensure collection exists with correct dimensions
    collections = [c.name for c in client.get_collections().collections]
    if COLLECTION not in collections:
        print(f"Creating collection '{COLLECTION}' ({EMBEDDING_DIM}-dim, cosine)...")
        client.create_collection(
            collection_name=COLLECTION,
            vectors_config=VectorParams(size=EMBEDDING_DIM, distance=Distance.COSINE),
        )
    else:
        # Validate existing collection dimensions
        info = client.get_collection(COLLECTION)
        existing_dim = info.config.params.vectors.size
        if existing_dim != EMBEDDING_DIM:
            print(f"ERROR: Collection '{COLLECTION}' has {existing_dim}-dim vectors but script expects {EMBEDDING_DIM}-dim.")
            print(f"  Delete and recreate: curl -X DELETE http://localhost:6333/collections/{COLLECTION}")
            sys.exit(1)

    # Get existing sources in collection
    existing_sources = set()
    if not args.force and not args.source:
        offset = None
        batch_size = 100
        while True:
            points, next_offset = client.scroll(
                COLLECTION, limit=batch_size, offset=offset,
                with_payload=["source"], with_vectors=False,
            )
            for p in points:
                existing_sources.add(p.payload.get("source", ""))
            if next_offset is None:
                break
            offset = next_offset

    # Discover sources
    sources = discover_sources(args.source)
    print(f"FibreFlow Qdrant Ingestion")
    print(f"  Embedding: {EMBEDDING_MODEL} ({EMBEDDING_DIM}-dim, local Ollama)")
    print(f"  Sources found: {len(sources)}")
    print(f"  Mode: {'dry-run' if args.dry_run else 'force' if args.force else 'incremental'}")
    print()

    total_chunks = 0
    total_embedded = 0
    total_failed = 0

    for si, (source_id, filepath) in enumerate(sources):
        print(f"  {source_id}")

        if not args.force and source_id in existing_sources:
            print(f"    Skipped (already in Qdrant, use --force to re-ingest)")
            continue

        text = filepath.read_text(encoding="utf-8", errors="replace")
        chunks = chunk_markdown(text, source_id)
        print(f"    {len(text):,} chars -> {len(chunks)} chunks")
        total_chunks += len(chunks)

        if args.dry_run:
            continue

        if not chunks:
            continue

        # Delete old points for this source before upserting
        if args.force:
            client.delete(
                collection_name=COLLECTION,
                points_selector=FilterSelector(
                    filter=Filter(
                        must=[FieldCondition(key="source", match=MatchValue(value=source_id))]
                    )
                ),
            )

        # Embed one at a time (Ollama doesn't batch)
        texts = [c["content"] for c in chunks]
        embedded = embed_texts(texts)

        # Upsert only successfully embedded points
        points = []
        for i, vec in embedded:
            chunk = chunks[i]
            points.append(PointStruct(
                id=point_id(source_id, i),
                vector=vec,
                payload={
                    "source": chunk["source"],
                    "section": chunk["section"],
                    "chunk_index": i,
                    "content": chunk["content"][:MAX_PAYLOAD_CHARS],
                    "metadata": {"ingested_by": "ingest-qdrant.py"},
                },
            ))

        source_failed = len(chunks) - len(embedded)
        total_failed += source_failed

        # Upsert in batches of 100
        for j in range(0, len(points), 100):
            client.upsert(COLLECTION, points=points[j : j + 100])

        total_embedded += len(embedded)
        msg = f"    Upserted {len(embedded)} points"
        if source_failed:
            msg += f" ({source_failed} failed)"
        print(msg)

        # Periodic memory check
        if (si + 1) % 20 == 0:
            gc.collect()
            rss_mb = check_rss()
            print(f"    [RSS: {rss_mb:.0f}MB]")

    # DB schema
    if not args.source:
        print("\n  db-schema")
        if not args.force and "db-schema" in existing_sources:
            print("    Skipped (already in Qdrant)")
        else:
            schema_chunks = fetch_db_schema()
            total_chunks += len(schema_chunks)

            if not args.dry_run and schema_chunks:
                if args.force:
                    client.delete(
                        collection_name=COLLECTION,
                        points_selector=FilterSelector(
                            filter=Filter(
                                must=[FieldCondition(key="source", match=MatchValue(value="db-schema"))]
                            )
                        ),
                    )

                texts = [c["content"] for c in schema_chunks]
                embedded = embed_texts(texts)

                points = []
                for i, vec in embedded:
                    chunk = schema_chunks[i]
                    points.append(PointStruct(
                        id=point_id("db-schema", i),
                        vector=vec,
                        payload={
                            "source": chunk["source"],
                            "section": chunk["section"],
                            "chunk_index": i,
                            "content": chunk["content"][:MAX_PAYLOAD_CHARS],
                            "metadata": {"ingested_by": "ingest-qdrant.py"},
                        },
                    ))

                schema_failed = len(schema_chunks) - len(embedded)
                total_failed += schema_failed

                for j in range(0, len(points), 100):
                    client.upsert(COLLECTION, points=points[j : j + 100])

                total_embedded += len(embedded)
                print(f"    Upserted {len(embedded)} points")

    # Report
    info = client.get_collection(COLLECTION)
    print(f"\n{'=' * 50}")
    print(f"  Embedding:         {EMBEDDING_MODEL} ({EMBEDDING_DIM}-dim)")
    print(f"  Chunks processed:  {total_chunks}")
    if not args.dry_run:
        print(f"  Chunks embedded:   {total_embedded}")
        print(f"  Chunks failed:     {total_failed}")
    print(f"  Collection total:  {info.points_count} points")
    print(f"  Collection status: {info.status}")
    rss_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    print(f"  Peak RSS:          {rss_mb:.0f}MB")
    print(f"{'=' * 50}")


if __name__ == "__main__":
    main()
