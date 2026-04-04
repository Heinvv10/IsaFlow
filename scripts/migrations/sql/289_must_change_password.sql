-- Migration 289: Add must_change_password column to users table
-- Required by pentest fix H2 (enforce password change after admin reset)

ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT false;
