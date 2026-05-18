-- Enable realtime broadcast for accounts so trader UI gets live updates
-- on balance / PnL / status / provisioning changes.
ALTER TABLE public.accounts REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.accounts;