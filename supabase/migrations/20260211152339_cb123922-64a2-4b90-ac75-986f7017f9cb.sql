
-- Create a dedicated seed staff user for payout initiation (separation of duties).
-- This user exists only to satisfy FK constraints and the initiator≠approver check.
-- Uses a deterministic UUID so reruns are safe.

DO $$
DECLARE
  _staff_id uuid := 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee01';
BEGIN
  -- Only create if not exists
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = _staff_id) THEN
    INSERT INTO auth.users (
      id,
      instance_id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at
    ) VALUES (
      _staff_id,
      '00000000-0000-0000-0000-000000000000',
      'authenticated',
      'authenticated',
      'seed-staff@internal.localhost',
      crypt('seed-staff-no-login-' || gen_random_uuid()::text, gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{"full_name":"Seed Staff (Internal)"}'::jsonb,
      now(),
      now()
    );
    RAISE NOTICE 'Created seed staff user: %', _staff_id;
  ELSE
    RAISE NOTICE 'Seed staff user already exists: %', _staff_id;
  END IF;
END $$;
