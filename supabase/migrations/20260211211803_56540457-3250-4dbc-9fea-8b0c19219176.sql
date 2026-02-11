-- Insert missing payout_payments for 3 DEMO seed payouts (idempotent)
INSERT INTO payout_payments (payout_id, provider, amount, currency, status, initiated_by, initiated_at, confirmed_at, provider_payment_id, provider_event_id)
VALUES
  ('66490e2b-2eec-4ef6-9a0f-44e6176af211', 'seed', 300.00, 'USD', 'confirmed', '65c43a0a-7182-448f-9753-ed9818030602', '2025-12-25T13:59:04Z', '2025-12-25T14:00:00Z', 'DEMO-PAY-001', 'seed-evt-001'),
  ('1fea975a-0259-40db-907d-11174909c2f8', 'seed', 300.00, 'USD', 'confirmed', '65c43a0a-7182-448f-9753-ed9818030602', '2026-01-09T13:59:04Z', '2026-01-09T14:00:00Z', 'DEMO-PAY-002', 'seed-evt-002'),
  ('1430d142-8203-4fa0-bf0a-d7ee16324971', 'seed', 300.00, 'USD', 'confirmed', '65c43a0a-7182-448f-9753-ed9818030602', '2026-01-24T13:59:04Z', '2026-01-24T14:00:00Z', 'DEMO-PAY-003', 'seed-evt-003')
ON CONFLICT DO NOTHING;