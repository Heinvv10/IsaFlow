-- Migration 580: index the reverse side of document_links
--
-- W5 exposes the document stores over MCP (list_documents / get_document /
-- list_unsupported_transactions) and extracts their queries out of
-- pages/api/accounting/documents.ts into documentQueryService.
--
-- The cross-linked-documents query has always filtered
--   WHERE dl.linked_entity_type = ? AND dl.linked_entity_id = ?
-- and document_links carries no index that serves it. The unique constraint
-- document_links_document_id_linked_entity_type_linked_entity_key leads with
-- document_id, and idx_document_links_document indexes document_id alone — a
-- lookup BY the linked entity therefore sequentially scans the table. That is
-- a pre-existing defect in the UI path, not one this workstream introduces;
-- exposing the same query to an agent that can call it in a loop is what makes
-- it worth fixing now.
--
-- Not CONCURRENTLY, and safe: document_links holds 0 rows in production
-- (as do procurement_documents and bank_transaction_attachments — see the W5
-- report), so the build takes no meaningful lock. If you are copying this into
-- a migration against a populated table, read the note at the top of 531
-- first: there the same statement blocks every write for a full scan.

CREATE INDEX IF NOT EXISTS idx_document_links_linked_entity
  ON document_links (linked_entity_type, linked_entity_id);
