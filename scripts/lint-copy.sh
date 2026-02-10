#!/usr/bin/env bash
# Copy Lint — flags absolutist/unverifiable language in marketing copy.
#
# Scans landing, pricing, checkout, and rules copy for banned words.
# Allowlisted patterns (e.g., "every trader is different") can be added below.
#
# Exit codes:
#   0 — clean
#   1 — banned words found (review required)

set -euo pipefail

BANNED_PATTERN='\b(always|never|guarantee|guaranteed|every|promise|100%|#1)\b'

# Files to scan (landing, pricing, checkout, rules, claims)
SCAN_DIRS=(
  "src/components/landing"
  "src/components/checkout"
  "src/pages/Checkout.tsx"
  "src/pages/Rules.tsx"
  "src/pages/Index.tsx"
  "src/lib/pricing-data.ts"
  "src/lib/payout-copy.ts"
  "src/lib/claims.ts"
)

# Allowlisted patterns (grep -v). Add exact strings that are intentionally kept.
ALLOWLIST=(
  "# Allowlisted"  # placeholder so array is never empty
)

# Build allowlist grep pattern
ALLOW_PATTERN=$(printf "|%s" "${ALLOWLIST[@]}")
ALLOW_PATTERN="${ALLOW_PATTERN:1}"  # strip leading |

FOUND=0

for target in "${SCAN_DIRS[@]}"; do
  if [ ! -e "$target" ]; then
    continue
  fi

  # grep recursively, case-insensitive, with line numbers
  HITS=$(grep -rniE "$BANNED_PATTERN" "$target" 2>/dev/null | grep -vE "$ALLOW_PATTERN" || true)

  if [ -n "$HITS" ]; then
    echo "⚠️  Absolutist language found in $target:"
    echo "$HITS"
    echo ""
    FOUND=1
  fi
done

if [ $FOUND -eq 1 ]; then
  echo "::error::Banned absolutist words detected in marketing copy. Review and soften, or add to allowlist in scripts/lint-copy.sh."
  exit 1
else
  echo "✓ No absolutist language detected in marketing copy."
  exit 0
fi
