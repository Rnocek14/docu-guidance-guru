CREATE UNIQUE INDEX IF NOT EXISTS staff_notifications_idem_ux
ON public.staff_notifications (idempotency_key)
WHERE idempotency_key IS NOT NULL;