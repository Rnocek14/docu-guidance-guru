-- 1) Seed geo signal for SEEDV2 payout user so B1 jurisdiction check passes
INSERT INTO geo_signals (user_id, signal_type, country_code, confidence, source, observed_at, metadata)
VALUES (
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee01',
  'ip_lookup',
  'US',
  90,
  'seed',
  now(),
  '{"region":"IL","city":"Chicago","ip":"203.0.113.10","qa_fixture":true}'::jsonb
)
ON CONFLICT DO NOTHING;

-- 2) Reset SEEDV2-EVAL-BREACH to breached_detected so C1 has a test target
UPDATE accounts
SET status = 'breached_detected', updated_at = now()
WHERE id = '6448ede7-db14-454a-929d-d064beed7d18'
  AND account_number = 'SEEDV2-EVAL-BREACH';

-- 3) Ensure at least one violation exists for the breach fixture
INSERT INTO violations (account_id, rule_type, description, detected_at)
SELECT
  '6448ede7-db14-454a-929d-d064beed7d18',
  'qa_breach_fixture',
  'Seeded breach fixture for qa-full-scan C1 test',
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM violations WHERE account_id = '6448ede7-db14-454a-929d-d064beed7d18'
);