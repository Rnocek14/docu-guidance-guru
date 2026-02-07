-- Add unique constraint on staff_notifications.idempotency_key to enforce idempotency
-- NULL values are allowed (not all notifications need idempotency keys)
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_notifications_idempotency_key
  ON public.staff_notifications (idempotency_key)
  WHERE idempotency_key IS NOT NULL;