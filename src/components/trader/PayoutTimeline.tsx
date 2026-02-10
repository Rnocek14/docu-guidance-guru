import { cn } from "@/lib/utils";
import { TIMELINE_STEPS, getTimelineIndex, getStatusCopy } from "@/lib/payout-copy";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";

interface PayoutTimelineProps {
  status: string;
  className?: string;
}

const STEP_LABELS: Record<string, string> = {
  pending: "Requested",
  under_review: "Reviewing",
  approved: "Approved",
  paid: "Paid",
};

/** Duration hints — guidance, not guarantees */
const STEP_DURATION_HINTS: Record<string, string> = {
  pending: "Queued for review",
  under_review: "Typically 1–3 business days",
  approved: "Usually same or next business day",
  paid: "",
};

/**
 * Visual step progression: Requested → Reviewing → Approved → Paid
 * Shows the trader exactly where their payout is in the pipeline.
 */
export function PayoutTimeline({ status, className }: PayoutTimelineProps) {
  const currentIndex = getTimelineIndex(status);
  const isTerminalFailure = currentIndex === -1;
  const statusCopy = getStatusCopy(status);

  // For terminal failures show a single-line status instead of the progression
  if (isTerminalFailure) {
    return (
      <div className={cn("rounded-lg border border-destructive/30 bg-destructive/5 p-4", className)}>
        <p className="text-sm font-medium text-destructive">{statusCopy.label}</p>
        <p className="text-xs text-muted-foreground mt-1">{statusCopy.description}</p>
      </div>
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      {/* Step indicators */}
      <div className="flex items-center justify-between">
        {TIMELINE_STEPS.map((step, i) => {
          const isCompleted = i < currentIndex;
          const isCurrent = i === currentIndex;
          const isFuture = i > currentIndex;
          // payment_initiated is a sub-state of approved — show spinner
          const isProcessing = isCurrent && (status === "payment_initiated" || status === "under_review");

          return (
            <div key={step} className="flex flex-1 items-center">
              {/* Step dot */}
              <div className="flex flex-col items-center gap-1.5">
                <div
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-full border-2 transition-colors",
                    isCompleted && "border-primary bg-primary text-primary-foreground",
                    isCurrent && !isProcessing && "border-primary bg-primary/10 text-primary",
                    isProcessing && "border-primary bg-primary/10 text-primary",
                    isFuture && "border-muted-foreground/30 bg-background text-muted-foreground/40"
                  )}
                >
                  {isCompleted ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : isProcessing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Circle className="h-3 w-3" />
                  )}
                </div>
                <span
                  className={cn(
                    "text-xs font-medium whitespace-nowrap",
                    (isCompleted || isCurrent) ? "text-foreground" : "text-muted-foreground/50"
                  )}
                >
                  {STEP_LABELS[step]}
                </span>
                {isCurrent && STEP_DURATION_HINTS[step] && (
                  <span className="text-[10px] text-muted-foreground/60 whitespace-nowrap">
                    {STEP_DURATION_HINTS[step]}
                  </span>
                )}
              </div>

              {/* Connector line (not after last step) */}
              {i < TIMELINE_STEPS.length - 1 && (
                <div
                  className={cn(
                    "h-0.5 flex-1 mx-2 mt-[-1.25rem]",
                    i < currentIndex ? "bg-primary" : "bg-muted-foreground/20"
                  )}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Current status description */}
      <p className="text-xs text-muted-foreground text-center">
        {statusCopy.description}
      </p>
    </div>
  );
}
