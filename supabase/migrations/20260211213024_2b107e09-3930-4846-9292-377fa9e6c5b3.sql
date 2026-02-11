-- Fix B1: Update geo signal to use correct signal_type that resolve_user_jurisdiction recognizes
UPDATE geo_signals
SET signal_type = 'ip_country'
WHERE user_id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee01'
  AND signal_type = 'ip_lookup'
  AND source = 'seed';

-- Fix C1: Reset SEEDV2-EVAL-BREACH back to breached_detected for re-testing
-- Also need to clear any existing idempotency keys so audit_increased assertion works
UPDATE accounts
SET status = 'breached_detected', updated_at = now()
WHERE id = '6448ede7-db14-454a-929d-d064beed7d18'
  AND account_number = 'SEEDV2-EVAL-BREACH';