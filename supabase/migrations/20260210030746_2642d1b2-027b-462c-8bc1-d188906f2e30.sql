-- Add ingest-specific audit action enum values
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'ingest_blocked';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'ingest_quarantined';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'ingest_error';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'ingest_rejected';