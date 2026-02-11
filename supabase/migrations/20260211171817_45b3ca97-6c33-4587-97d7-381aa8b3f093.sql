-- Disable user triggers for seed re-run
ALTER TABLE accounts DISABLE TRIGGER USER;
ALTER TABLE payouts DISABLE TRIGGER USER;