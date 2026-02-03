/**
 * Priority scoring for review queue accounts
 * Higher score = more urgent, should appear first
 */

interface QueueAccountForPriority {
  status: string;
  flags_count: number;
  violations_count: number;
  updated_at: string;
  last_event_at?: string | null;
}

interface ViolationForPriority {
  rule_type: string;
  actual_value: number | null;
  rule_threshold: number | null;
}

/**
 * Calculate priority score for a queue account
 * 
 * Priority buckets:
 * - Tier 1 (must look now): breached_detected (100), under_review (90)
 * - Tier 2 (money/reputation): payout_requested (80), payout_under_review (70)
 * 
 * Modifiers:
 * - +10 if there are open flags
 * - +5 if violations include total drawdown breach
 * - +2 for each additional violation (max +10)
 */
export function calculatePriorityScore(
  account: QueueAccountForPriority,
  violations?: ViolationForPriority[]
): number {
  let score = 0;

  // Base score by status
  switch (account.status) {
    case 'breached_detected':
      score = 100;
      break;
    case 'under_review':
      score = 90;
      break;
    case 'payout_requested':
      score = 80;
      break;
    case 'payout_under_review':
      score = 70;
      break;
    default:
      score = 50;
  }

  // Flag modifier
  if (account.flags_count > 0) {
    score += 10;
  }

  // Violation modifiers
  if (violations && violations.length > 0) {
    // Check for total drawdown breach (more severe than daily loss)
    // Support multiple possible naming conventions
    const hasDrawdownBreach = violations.some(v => 
      v.rule_type === 'max_total_drawdown' || 
      v.rule_type === 'total_drawdown' || 
      v.rule_type === 'max_drawdown'
    );
    if (hasDrawdownBreach) {
      score += 5;
    }

    // Additional violations bump priority (max +10)
    score += Math.min(violations.length * 2, 10);
  } else if (account.violations_count > 0) {
    // Use count if violations array not provided
    score += Math.min(account.violations_count * 2, 10);
  }

  return score;
}

/**
 * Get priority label for display
 */
export function getPriorityLabel(score: number): { label: string; variant: 'destructive' | 'default' | 'secondary' | 'outline' } {
  if (score >= 100) {
    return { label: 'Critical', variant: 'destructive' };
  } else if (score >= 80) {
    return { label: 'High', variant: 'default' };
  } else if (score >= 60) {
    return { label: 'Medium', variant: 'secondary' };
  } else {
    return { label: 'Low', variant: 'outline' };
  }
}

/**
 * Sort accounts by priority (desc), then by recency (desc)
 */
export function sortByPriority<T extends QueueAccountForPriority>(
  accounts: T[],
  violations?: Map<string, ViolationForPriority[]>
): T[] {
  return [...accounts].sort((a, b) => {
    const scoreA = calculatePriorityScore(a, violations?.get((a as unknown as { id: string }).id));
    const scoreB = calculatePriorityScore(b, violations?.get((b as unknown as { id: string }).id));

    // First sort by priority score (desc)
    if (scoreB !== scoreA) {
      return scoreB - scoreA;
    }

    // Then by last event or updated_at (desc)
    const dateA = new Date(a.last_event_at || a.updated_at).getTime();
    const dateB = new Date(b.last_event_at || b.updated_at).getTime();
    return dateB - dateA;
  });
}
