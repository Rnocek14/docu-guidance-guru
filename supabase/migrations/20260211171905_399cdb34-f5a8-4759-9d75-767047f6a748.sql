-- Fix P0 seed status issues directly

-- P0-1: EVAL-BREACH should be breached_detected (not active)
UPDATE accounts SET status = 'breached_detected', updated_at = now()
WHERE account_number = 'SEEDV2-EVAL-BREACH' AND status = 'active';

-- P0-2: VERI-PASS should be passed (not active) 
UPDATE accounts SET status = 'passed', passed_at = now() - interval '30 days', updated_at = now()
WHERE account_number = 'SEEDV2-VERI-PASS' AND status = 'active';

-- Insert passed event for VERI-PASS
INSERT INTO account_events (account_id, event_type, idempotency_key, event_data)
SELECT id, 'passed', 'seed.passed:' || id, '{"phase":"verification","seed_forced":true}'::jsonb
FROM accounts WHERE account_number = 'SEEDV2-VERI-PASS'
ON CONFLICT (idempotency_key) DO NOTHING;

-- P0-3: PERF-ELIGIBLE should be active (not passed) - perf accounts stay active
UPDATE accounts SET status = 'active', passed_at = NULL, updated_at = now()
WHERE account_number = 'SEEDV2-PERF-ELIGIBLE' AND status = 'passed';

-- P0-4: PERF-NEAR-CAP should be active (not passed) - perf accounts stay active
UPDATE accounts SET status = 'active', passed_at = NULL, updated_at = now()
WHERE account_number = 'SEEDV2-PERF-NEAR-CAP' AND status = 'passed';

-- P0-5: Create phase transition for EVAL-PASS → VERI-ACTIVE (V6 fix)
INSERT INTO account_phase_transitions (from_account_id, from_cohort_id, to_account_id, to_cohort_id)
SELECT 
  ep.id, ep.cohort_id,
  va.id, va.cohort_id
FROM accounts ep, accounts va
WHERE ep.account_number = 'SEEDV2-EVAL-PASS'
  AND va.account_number = 'SEEDV2-VERI-ACTIVE'
ON CONFLICT DO NOTHING;

-- P0-6: Create phase transition for VERI-PASS → PERF-ELIGIBLE
INSERT INTO account_phase_transitions (from_account_id, from_cohort_id, to_account_id, to_cohort_id)
SELECT 
  vp.id, vp.cohort_id,
  pe.id, pe.cohort_id
FROM accounts vp, accounts pe
WHERE vp.account_number = 'SEEDV2-VERI-PASS'
  AND pe.account_number = 'SEEDV2-PERF-ELIGIBLE'
ON CONFLICT DO NOTHING;

-- Re-enable triggers
ALTER TABLE accounts ENABLE TRIGGER USER;
ALTER TABLE payouts ENABLE TRIGGER USER;