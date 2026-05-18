
-- Enable RLS on realtime.messages (idempotent)
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

-- Drop prior versions if re-run
DROP POLICY IF EXISTS "Users subscribe to own account channel" ON realtime.messages;
DROP POLICY IF EXISTS "Staff subscribe to any channel" ON realtime.messages;

-- Authenticated users can only read/write messages on their own topic
CREATE POLICY "Users subscribe to own account channel"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  realtime.topic() = 'accounts:user:' || auth.uid()::text
);

-- Staff bypass for monitoring
CREATE POLICY "Staff subscribe to any channel"
ON realtime.messages
FOR SELECT
TO authenticated
USING (
  public.has_any_role(auth.uid(), ARRAY['admin'::public.app_role, 'risk_officer'::public.app_role, 'support'::public.app_role])
);
