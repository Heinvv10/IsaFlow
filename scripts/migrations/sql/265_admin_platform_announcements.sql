-- Migration 265: Admin Platform — System announcements
-- Allows ISAFlow admins to broadcast messages to all companies, specific plans,
-- or individual companies (maintenance windows, new features, warnings).

CREATE TABLE IF NOT EXISTS system_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(20) DEFAULT 'info' CHECK (type IN ('info', 'warning', 'maintenance', 'feature')),
  target VARCHAR(20) DEFAULT 'all' CHECK (target IN ('all', 'plan', 'company')),
  target_ids UUID[] DEFAULT '{}',
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  is_dismissible BOOLEAN DEFAULT true,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
