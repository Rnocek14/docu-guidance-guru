#!/usr/bin/env bash
# CI guard: Fail if hardcoded preview domains or Supabase URLs appear in edge functions.
# Run in CI to prevent accidental regression.

set -euo pipefail

ERRORS=0

# Pattern 1: Hardcoded Supabase project URL (should use env var)
if grep -rn 'https://sfxmgwkrjwuerfkqxokq\.supabase\.co' supabase/functions/ --include='*.ts' 2>/dev/null; then
  echo "❌ FAIL: Hardcoded Supabase URL found in edge functions. Use Deno.env.get('SUPABASE_URL') instead."
  ERRORS=$((ERRORS + 1))
fi

# Pattern 2: Lovable preview domain (never route money here)
if grep -rn 'id-preview--' supabase/functions/ --include='*.ts' 2>/dev/null; then
  echo "❌ FAIL: Preview domain reference found in edge functions. Remove all preview URL fallbacks."
  ERRORS=$((ERRORS + 1))
fi

# Pattern 3: Lovable app domain hardcoded
if grep -rn '\.lovable\.app' supabase/functions/ --include='*.ts' 2>/dev/null; then
  echo "❌ FAIL: Hardcoded .lovable.app domain found in edge functions. Use APP_ORIGIN env var."
  ERRORS=$((ERRORS + 1))
fi

# Pattern 4: 'guest' as user_id literal
if grep -rn "user_id.*['\"]guest['\"]" supabase/functions/ --include='*.ts' 2>/dev/null; then
  echo "❌ FAIL: 'guest' user_id found in edge functions. All checkout paths must require authentication."
  ERRORS=$((ERRORS + 1))
fi

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "🚫 $ERRORS hardcoded URL pattern(s) detected. Fix before deploying."
  exit 1
fi

echo "✅ No hardcoded URLs or preview domains found in edge functions."
exit 0
