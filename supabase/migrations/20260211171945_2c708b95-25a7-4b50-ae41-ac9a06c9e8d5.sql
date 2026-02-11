-- Insert violation for EVAL-BREACH (daily loss breach)
INSERT INTO violations (account_id, rule_type, description, actual_value, rule_threshold, detected_at, breach_day)
SELECT a.id, 'max_daily_loss', 'Daily loss exceeded 5% limit (-5.2% on single day)', 5.2, 5.0, now(), (now() - interval '21 days')::date
FROM accounts a WHERE a.account_number = 'SEEDV2-EVAL-BREACH'
ON CONFLICT DO NOTHING;