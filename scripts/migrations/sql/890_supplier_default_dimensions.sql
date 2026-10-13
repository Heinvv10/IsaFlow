-- 890: A supplier's default CC1 / CC2 / BU (brief §6 supplier master, plan Phase 3 step 2).
--
-- Bills carry the analysis dimensions on their expense lines (870), but the
-- bill screen offered no CC/BU and nothing defaulted them, so bills posted
-- untagged and had to be back-tagged afterwards (Hein, 12 Oct 2026). A
-- supplier's coding rule may now name the CC1 (FNO), CC2 (project) and BU its
-- bill lines default to. A line's own dimensions always win; a line naming a
-- CC2 never takes the default CC1 (its FNO is derived from that project
-- instead) — the same precedence as a card's defaults (§5.5).
--
-- Scope: a bill created through createSupplierInvoice takes the defaults — the
-- bill screen / REST POST, the MCP create_supplier_invoice and
-- bulk_create_supplier_invoices, and the Sage import. It does NOT reach the
-- writers that insert bill lines directly: captured and auto-published bills
-- (capture/captureBillLines, the AI invoice pipeline, capture post), recurring
-- bills, or a draft's line replacement (update_supplier_invoice). Those bills
-- still post untagged until a later change gives them the same read.
--
-- Opt-in per supplier: no rule sets these today, so no bill changes until one does.
-- Rollback: drop the three columns (bills already created keep their lines' tags).

ALTER TABLE supplier_coding_rules
  ADD COLUMN IF NOT EXISTS default_cc1_id UUID REFERENCES cost_centres(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS default_cc2_id UUID REFERENCES cost_centres(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS default_bu_id  UUID REFERENCES business_units(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_supplier_coding_rules_default_cc1 ON supplier_coding_rules(default_cc1_id) WHERE default_cc1_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_supplier_coding_rules_default_cc2 ON supplier_coding_rules(default_cc2_id) WHERE default_cc2_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_supplier_coding_rules_default_bu  ON supplier_coding_rules(default_bu_id)  WHERE default_bu_id  IS NOT NULL;
