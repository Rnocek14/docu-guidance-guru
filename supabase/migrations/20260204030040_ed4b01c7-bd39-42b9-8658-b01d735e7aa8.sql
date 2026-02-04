-- Add evidence_pack_exported to audit_action enum
ALTER TYPE public.audit_action ADD VALUE IF NOT EXISTS 'evidence_pack_exported';