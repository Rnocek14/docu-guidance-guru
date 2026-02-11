
-- Re-enable user triggers after seed
ALTER TABLE accounts ENABLE TRIGGER USER;
ALTER TABLE payouts ENABLE TRIGGER USER;
