
-- 1) Block all client-side inserts on accounts.
DROP POLICY IF EXISTS "Traders can insert own accounts" ON public.accounts;
CREATE POLICY "No client inserts on accounts"
  ON public.accounts
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

-- 2) Restrict client inserts on payout_methods: users cannot self-verify or self-unblock.
DROP POLICY IF EXISTS "Users can insert own payout methods" ON public.payout_methods;
CREATE POLICY "Users can insert own payout methods"
  ON public.payout_methods
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND is_verified = false
    AND is_blocked = false
  );

-- 3) Convert internal_secrets deny policy to RESTRICTIVE so it cannot be
--    accidentally overridden by an additional permissive policy.
DROP POLICY IF EXISTS deny_all_client_access ON public.internal_secrets;
CREATE POLICY deny_all_client_access
  ON public.internal_secrets
  AS RESTRICTIVE
  FOR ALL
  TO public
  USING (false)
  WITH CHECK (false);

-- 4) Rotate CRON_SECRET to a freshly generated random value.
--    Edge functions read CRON_SECRET from internal_secrets as a fallback,
--    so rotating here invalidates the previously-committed plaintext secret.
UPDATE public.internal_secrets
SET value = encode(gen_random_bytes(32), 'hex'),
    updated_at = now()
WHERE key = 'CRON_SECRET';
