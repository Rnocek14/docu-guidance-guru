/**
 * Canonical payout copy constants.
 *
 * Every eligibility reason code from `calculate_payout_eligibility` and
 * every payout lifecycle status maps to a single, trader-facing copy block.
 *
 * Rules:
 *  - No "you violated" language
 *  - No absolutes ("always", "guaranteed")
 *  - No dead-ends ("contact support" unless truly needed)
 *  - Always explain *why* + *what next*
 */

// ─── Eligibility reason codes ────────────────────────────────────────────

export type ReasonSeverity = 'info' | 'warning' | 'blocking';

export interface ReasonCopy {
  headline: string;
  explanation: string;
  nextAction: string;
  severity: ReasonSeverity;
}

export const REASON_CODE_COPY: Record<string, ReasonCopy> = {
  // Core profit / performance
  NO_PROFIT: {
    headline: "No Eligible Profit",
    explanation:
      "Your account hasn't generated eligible profit yet.",
    nextAction: "Continue trading within the rules to build profit.",
    severity: 'warning',
  },
  PROFIT_BUFFER: {
    headline: "Maintain Profit Buffer",
    explanation:
      "You need to maintain a minimum profit buffer above your payout amount to remain eligible.",
    nextAction: "Continue trading while maintaining your buffer.",
    severity: 'warning',
  },
  MIN_WINNING_DAYS: {
    headline: "Complete Required Winning Days",
    explanation:
      "A minimum number of profitable trading days is required before requesting a payout.",
    nextAction: "Trade additional days while staying within the rules.",
    severity: 'warning',
  },

  // Timing / cooldown
  COOLING_PERIOD: {
    headline: "Waiting Period in Progress",
    explanation:
      "A short waiting period applies before your first payout request can be submitted.",
    nextAction: "No action required — eligibility will update automatically.",
    severity: 'info',
  },
  COOLDOWN: {
    headline: "Payout Cooldown Active",
    explanation:
      "A cooldown applies between payout requests to ensure account stability.",
    nextAction: "No action required — check back once the cooldown ends.",
    severity: 'info',
  },

  // Account / phase status
  NOT_PERFORMANCE_PHASE: {
    headline: "Performance Phase Required",
    explanation:
      "Payouts are only available once your account reaches the Performance phase.",
    nextAction: "Complete the evaluation and verification phases.",
    severity: 'blocking',
  },
  BAD_STATUS: {
    headline: "Account Not Eligible",
    explanation:
      "Your account status doesn't currently allow payout requests.",
    nextAction: "Review your account status for details.",
    severity: 'blocking',
  },
  ACCOUNT_NOT_FOUND: {
    headline: "Account Not Found",
    explanation:
      "We couldn't locate an eligible account for this request.",
    nextAction: "Refresh the page or contact support if the issue persists.",
    severity: 'blocking',
  },

  // Risk / review
  PENDING_VIOLATIONS: {
    headline: "Account Review in Progress",
    explanation:
      "Your account has pending reviews that must be resolved before payout eligibility can be confirmed.",
    nextAction: "No action required — you'll be notified once the review completes.",
    severity: 'warning',
  },

  // Cap / structural
  LIFETIME_CAP: {
    headline: "Lifetime Payout Cap Reached",
    explanation:
      "This account has reached its maximum lifetime payout limit.",
    nextAction: "Start a new evaluation to continue earning rewards.",
    severity: 'blocking',
  },
} as const;

/** Fallback for any unknown reason code */
export const UNKNOWN_REASON_COPY: ReasonCopy = {
  headline: "Payout Unavailable",
  explanation:
    "Your account doesn't currently meet all payout requirements.",
  nextAction: "Review the eligibility details below.",
  severity: 'blocking',
};

export function getReasonCopy(code: string | undefined): ReasonCopy {
  if (!code) return UNKNOWN_REASON_COPY;
  return REASON_CODE_COPY[code] ?? UNKNOWN_REASON_COPY;
}

// ─── Payout lifecycle status labels ──────────────────────────────────────

export interface StatusCopy {
  label: string;
  description: string;
}

export const PAYOUT_STATUS_COPY: Record<string, StatusCopy> = {
  pending: {
    label: "Requested",
    description: "We've received your request and it's been queued for review.",
  },
  under_review: {
    label: "Under Review",
    description:
      "Our team is reviewing your account activity to confirm eligibility.",
  },
  approved: {
    label: "Approved",
    description:
      "Your payout has been approved and is being prepared for payment.",
  },
  payment_initiated: {
    label: "Processing",
    description: "Payment is being processed through our payment partner.",
  },
  paid: {
    label: "Completed",
    description: "Your payout has been sent successfully.",
  },
  paid_confirmed: {
    label: "Completed",
    description: "Your payout has been sent and confirmed.",
  },
  payment_failed: {
    label: "Payment Issue",
    description:
      "There was an issue processing your payment. Our team has been notified.",
  },
  rejected: {
    label: "Not Approved",
    description:
      "This request couldn't be approved based on account status at the time of review.",
  },
} as const;

export const UNKNOWN_STATUS_COPY: StatusCopy = {
  label: "Unknown",
  description: "Status information is unavailable.",
};

export function getStatusCopy(status: string): StatusCopy {
  return PAYOUT_STATUS_COPY[status] ?? UNKNOWN_STATUS_COPY;
}

// ─── Timeline step ordering ─────────────────────────────────────────────

/** Canonical ordering for the payout progress timeline. */
export const TIMELINE_STEPS = [
  "pending",
  "under_review",
  "approved",
  "paid",
] as const;

export type TimelineStep = (typeof TIMELINE_STEPS)[number];

/**
 * Returns the 0-based index of the *current* step for timeline rendering.
 * Terminal failures (rejected, payment_failed) return -1.
 * payment_initiated maps to the "approved" step (index 2).
 * paid_confirmed maps to the "paid" step (index 3).
 */
export function getTimelineIndex(status: string): number {
  const map: Record<string, number> = {
    pending: 0,
    under_review: 1,
    approved: 2,
    payment_initiated: 2,
    paid: 3,
    paid_confirmed: 3,
  };
  return map[status] ?? -1;
}
