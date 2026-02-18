import { z } from 'zod';

// ── Sub-types ──

export interface DomainCheck {
  name: string;
  ok: boolean;
  severity: 'blocker' | 'warning';
  detail: string;
}

export interface DomainResult {
  safe: boolean;
  signal: string;
  checks: DomainCheck[];
  blockerCount: number;
  warningCount: number;
}

export interface LockState {
  inbound_paused: boolean;
  outbound_paused: boolean;
  intake_paused: boolean;
  intake_unknown: boolean;
  lock_owner: 'governor' | 'operator' | 'none';
  pause_reason: string | null;
  paused_at: string | null;
}

export interface GovernorConfig {
  enabled: boolean;
  auto_lock: boolean;
  auto_unlock: boolean;
  min_net_buffer: number;
  unlock_after_consecutive_safe: number;
  strict_launch_mode: boolean;
}

// ── Main response ──

export interface GovernorResult {
  verdict: 'safe' | 'not_safe' | 'error';
  capital: DomainResult;
  processor: DomainResult;
  cohort: DomainResult;
  riskEngine: DomainResult;
  blockers: { domain: string; detail: string; severity: string }[];
  warnings: { domain: string; detail: string }[];
  autoAction: string;
  autoActionDetail: string;
  certifiedAt: string;
  safeStreak: number;
  strictMode: boolean;
  unlockThreshold: number;
  lockState: LockState;
  effectiveConfig: GovernorConfig;
  source: 'cron' | 'manual';
}

// ── Certification history row (DB shape) ──

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

// ── Zod schema for runtime contract validation ──

const DomainCheckSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  severity: z.enum(['blocker', 'warning']),
  detail: z.string(),
});

const DomainResultSchema = z.object({
  safe: z.boolean(),
  signal: z.string(),
  checks: z.array(DomainCheckSchema),
  blockerCount: z.number(),
  warningCount: z.number(),
});

const LockStateSchema = z.object({
  inbound_paused: z.boolean(),
  outbound_paused: z.boolean(),
  intake_paused: z.boolean(),
  intake_unknown: z.boolean(),
  lock_owner: z.enum(['governor', 'operator', 'none']),
  pause_reason: z.string().nullable(),
  paused_at: z.string().nullable(),
});

const GovernorConfigSchema = z.object({
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
