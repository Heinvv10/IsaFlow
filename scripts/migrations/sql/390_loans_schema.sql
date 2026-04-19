-- Migration 390: Loan amortisation module schema
-- Tables: loan_rate_curves, loan_rate_points, loans, loan_events,
--         loan_schedule_runs, loan_schedule_rows, loan_gl_postings, loan_period_locks

-- ── Rate curves ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS loan_rate_curves (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  name        text NOT NULL,
  source      text,
  is_system   boolean DEFAULT false,
  created_at  timestamptz DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS loan_rate_curves_company_idx ON loan_rate_curves (company_id);

CREATE TABLE IF NOT EXISTS loan_rate_points (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curve_id       uuid NOT NULL REFERENCES loan_rate_curves(id) ON DELETE CASCADE,
  effective_date date NOT NULL,
  rate           numeric(8,4) NOT NULL,
  UNIQUE (curve_id, effective_date)
);

CREATE INDEX IF NOT EXISTS loan_rate_points_curve_date_idx ON loan_rate_points (curve_id, effective_date);

-- ── Loan master ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS loans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id),
  counterparty_id       uuid,
  gl_account_id         uuid,
  curve_id              uuid REFERENCES loan_rate_curves(id),
  reference             text,
  product               text,
  description           text,
  principal             numeric(18,2) NOT NULL,
  start_date            date NOT NULL,
  term_months           integer NOT NULL,
  rate_mode             text NOT NULL CHECK (rate_mode IN ('FIXED','PRIME_PLUS','PRIME_MINUS')),
  margin                numeric(8,4) DEFAULT 0,
  fixed_rate            numeric(8,4),
  residual              numeric(18,2) DEFAULT 0,
  day_count             text DEFAULT 'ACTUAL_365' CHECK (day_count IN ('ACTUAL_365','ACTUAL_360','30_360')),
  reprice_mode          text DEFAULT 'RESOLVE_ON_RATE_CHANGE' CHECK (reprice_mode IN ('RESOLVE_ON_RATE_CHANGE','RESOLVE_EVERY_PERIOD','FIXED_INSTALLMENT')),
  skip_mode             text DEFAULT 'MAINTAIN_TERM' CHECK (skip_mode IN ('EXTEND_TERM','MAINTAIN_TERM')),
  lump_mode             text DEFAULT 'REDUCE_INSTALLMENT' CHECK (lump_mode IN ('REDUCE_INSTALLMENT','MAINTAIN_INSTALLMENT')),
  recurring_skip_months integer[] DEFAULT '{}',
  status                text DEFAULT 'active' CHECK (status IN ('active','closed','written_off')),
  nca_compliant         boolean DEFAULT true,
  currency              text DEFAULT 'ZAR',
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS loans_company_idx ON loans (company_id);
CREATE INDEX IF NOT EXISTS loans_company_status_idx ON loans (company_id, status);
CREATE INDEX IF NOT EXISTS loans_curve_idx ON loans (curve_id);

-- ── Loan events (immutable append-only) ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS loan_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id     uuid NOT NULL REFERENCES loans(id),
  company_id  uuid NOT NULL REFERENCES companies(id),
  event_date  date NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('LUMP','SKIP','RESTRUCTURE','WRITEOFF')),
  amount      numeric(18,2),
  note        text,
  posted_by   uuid,
  posted_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS loan_events_loan_idx ON loan_events (loan_id);
CREATE INDEX IF NOT EXISTS loan_events_company_idx ON loan_events (company_id);

-- ── Schedule cache ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS loan_schedule_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id         uuid NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  company_id      uuid NOT NULL REFERENCES companies(id),
  computed_at     timestamptz DEFAULT now(),
  engine_version  text NOT NULL,
  inputs_hash     text NOT NULL
);

CREATE INDEX IF NOT EXISTS loan_schedule_runs_loan_idx ON loan_schedule_runs (loan_id, computed_at DESC);

CREATE TABLE IF NOT EXISTS loan_schedule_rows (
  run_id      uuid NOT NULL REFERENCES loan_schedule_runs(id) ON DELETE CASCADE,
  period      integer NOT NULL,
  date        date NOT NULL,
  opening     numeric(18,2),
  rate        numeric(8,6),
  installment numeric(18,2),
  interest    numeric(18,2),
  principal   numeric(18,2),
  lump        numeric(18,2),
  skip_flag   boolean DEFAULT false,
  payment     numeric(18,2),
  closing     numeric(18,2),
  st_liability numeric(18,2),
  extrapolated boolean DEFAULT false,
  nca_flagged  boolean DEFAULT false,
  PRIMARY KEY (run_id, period)
);

CREATE INDEX IF NOT EXISTS loan_schedule_rows_run_idx ON loan_schedule_rows (run_id);

-- ── GL postings ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS loan_gl_postings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id),
  loan_id           uuid NOT NULL REFERENCES loans(id),
  period            integer NOT NULL,
  posting_date      date NOT NULL,
  account_id        uuid NOT NULL,
  debit             numeric(18,2) DEFAULT 0,
  credit            numeric(18,2) DEFAULT 0,
  narrative         text,
  posted_period     char(6),
  reversal_of       uuid REFERENCES loan_gl_postings(id),
  journal_entry_id  uuid,
  created_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS loan_gl_postings_company_loan_idx ON loan_gl_postings (company_id, loan_id);
CREATE INDEX IF NOT EXISTS loan_gl_postings_period_idx ON loan_gl_postings (company_id, posted_period);

-- ── Period locks ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS loan_period_locks (
  company_id  uuid NOT NULL REFERENCES companies(id),
  yyyymm      char(6) NOT NULL,
  locked_at   timestamptz,
  locked_by   uuid,
  PRIMARY KEY (company_id, yyyymm)
);
