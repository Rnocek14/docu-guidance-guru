import { z } from 'zod';

// ── Zod schemas (single source of truth) ──

export const DomainCheckSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  severity: z.enum(['blocker', 'warning']),
  detail: z.string(),
});

export const DomainResultSchema = z.object({
  safe: z.boolean(),
  signal: z.string(),
  checks: z.array(DomainCheckSchema),
  blockerCount: z.number(),
  warningCount: z.number(),
});

export const LockStateSchema = z.object({
  inbound_paused: z.boolean(),
  outbound_paused: z.boolean(),
  intake_paused: z.boolean(),
  intake_unknown: z.boolean(),
  lock_owner: z.enum(['governor', 'operator', 'none']),
  pause_reason: z.string().nullable(),
  paused_at: z.string().nullable(),
});

export const GovernorConfigSchema = z.object({
  enabled: z.boolean(),
  auto_lock: z.boolean(),
  auto_unlock: z.boolean(),
  min_net_buffer: z.number(),
  unlock_after_consecutive_safe: z.number(),
  strict_launch_mode: z.boolean(),
});

export const GovernorResultSchema = z.object({
  verdict: z.enum(['safe', 'not_safe', 'error']),
  capital: DomainResultSchema,
  processor: DomainResultSchema,
  cohort: DomainResultSchema,
  riskEngine: DomainResultSchema,
  blockers: z.array(z.object({ domain: z.string(), detail: z.string(), severity: z.string() })),
  warnings: z.array(z.object({ domain: z.string(), detail: z.string() })),
  autoAction: z.string(),
  autoActionDetail: z.string(),
  certifiedAt: z.string(),
  safeStreak: z.number(),
  strictMode: z.boolean(),
  unlockThreshold: z.number(),
  lockState: LockStateSchema,
  effectiveConfig: GovernorConfigSchema,
  source: z.enum(['cron', 'manual']),
});

// ── Inferred types (derived from schemas — no drift possible) ──

export type DomainCheck = z.infer<typeof DomainCheckSchema>;
export type DomainResult = z.infer<typeof DomainResultSchema>;
export type LockState = z.infer<typeof LockStateSchema>;
export type GovernorConfig = z.infer<typeof GovernorConfigSchema>;
export type GovernorResult = z.infer<typeof GovernorResultSchema>;

// ── Certification history row (DB shape, not from Zod) ──

export interface CertHistory {
  id: string;
  certified_at: string;
  verdict: string;
  capital_safe: boolean;
  processor_safe: boolean;
  cohort_safe: boolean;
  risk_engine_safe: boolean;
  auto_action: string;
  auto_action_detail: string;
  safe_streak: number;
}
