-- =============================================
-- PHASE 1: RISK ANALYTICS FOUNDATION SCHEMA
-- =============================================

-- 1. ENUMS
-- =============================================

-- User roles enum
CREATE TYPE public.app_role AS ENUM ('trader', 'risk_officer', 'support', 'admin');

-- Account status enum (granular states per revised plan)
CREATE TYPE public.account_status AS ENUM (
  'active',
  'breached_detected',
  'under_review',
  'failed_confirmed',
  'passed',
  'payout_requested',
  'payout_under_review',
  'payout_approved',
  'closed'
);

-- Payout status enum
CREATE TYPE public.payout_status AS ENUM (
  'pending',
  'under_review',
  'approved',
  'rejected',
  'paid'
);

-- Flag status enum
CREATE TYPE public.flag_status AS ENUM (
  'pending',
  'cleared',
  'escalated',
  'resolved'
);

-- Audit action types
CREATE TYPE public.audit_action AS ENUM (
  'account_created',
  'status_changed',
  'breach_detected',
  'flag_created',
  'flag_cleared',
  'flag_escalated',
  'payout_requested',
  'payout_approved',
  'payout_rejected',
  'failure_confirmed',
  'role_assigned',
  'role_revoked',
  'cohort_assigned',
  'intake_paused',
  'intake_resumed'
);

-- 2. PROFILES TABLE
-- =============================================
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  email TEXT NOT NULL,
  full_name TEXT,
  avatar_url TEXT,
  kyc_status TEXT DEFAULT 'pending',
  kyc_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 3. USER ROLES TABLE (SEPARATE FOR SECURITY)
-- =============================================
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role public.app_role NOT NULL,
  assigned_by UUID REFERENCES auth.users(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- 4. COHORTS TABLE (IMMUTABLE RULE SETS)
-- =============================================
CREATE TABLE public.cohorts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  -- Rule parameters (frozen once assigned)
  max_daily_loss_percent DECIMAL(5,2) NOT NULL DEFAULT 5.00,
  max_total_drawdown_percent DECIMAL(5,2) NOT NULL DEFAULT 10.00,
  profit_target_percent DECIMAL(5,2) NOT NULL DEFAULT 10.00,
  min_trading_days INTEGER NOT NULL DEFAULT 5,
  max_position_size_percent DECIMAL(5,2) NOT NULL DEFAULT 20.00,
  -- Intake control
  intake_active BOOLEAN NOT NULL DEFAULT true,
  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id),
  is_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (name, version)
);

ALTER TABLE public.cohorts ENABLE ROW LEVEL SECURITY;

-- 5. ACCOUNTS TABLE (TRADING ACCOUNTS)
-- =============================================
CREATE TABLE public.accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  cohort_id UUID REFERENCES public.cohorts(id) NOT NULL,
  account_number TEXT NOT NULL UNIQUE,
  status public.account_status NOT NULL DEFAULT 'active',
  -- Balance tracking
  starting_balance DECIMAL(15,2) NOT NULL DEFAULT 100000.00,
  current_balance DECIMAL(15,2) NOT NULL DEFAULT 100000.00,
  highest_balance DECIMAL(15,2) NOT NULL DEFAULT 100000.00,
  -- Performance metrics
  total_pnl DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  daily_pnl DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  trading_days_count INTEGER NOT NULL DEFAULT 0,
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  passed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ
);

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

-- 6. TRADES TABLE
-- =============================================
CREATE TABLE public.trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES public.accounts(id) ON DELETE CASCADE NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity DECIMAL(15,6) NOT NULL,
  entry_price DECIMAL(15,6) NOT NULL,
  exit_price DECIMAL(15,6),
  pnl DECIMAL(15,2),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed'))
);

ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;

-- 7. VIOLATIONS TABLE (BREACH DETECTIONS)
-- =============================================
CREATE TABLE public.violations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES public.accounts(id) ON DELETE CASCADE NOT NULL,
  rule_type TEXT NOT NULL,
  rule_threshold DECIMAL(15,4),
  actual_value DECIMAL(15,4),
  description TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Human confirmation tracking
  confirmed_by UUID REFERENCES auth.users(id),
  confirmed_at TIMESTAMPTZ,
  confirmation_notes TEXT
);

ALTER TABLE public.violations ENABLE ROW LEVEL SECURITY;

-- 8. RISK SCORES TABLE (ADVISORY ONLY)
-- =============================================
CREATE TABLE public.risk_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES public.accounts(id) ON DELETE CASCADE NOT NULL,
  -- Advisory scores (0-100)
  edge_score INTEGER NOT NULL DEFAULT 0 CHECK (edge_score >= 0 AND edge_score <= 100),
  abuse_score INTEGER NOT NULL DEFAULT 0 CHECK (abuse_score >= 0 AND abuse_score <= 100),
  payment_risk_score INTEGER NOT NULL DEFAULT 0 CHECK (payment_risk_score >= 0 AND payment_risk_score <= 100),
  -- Score explanations
  edge_factors JSONB DEFAULT '[]'::jsonb,
  abuse_factors JSONB DEFAULT '[]'::jsonb,
  payment_factors JSONB DEFAULT '[]'::jsonb,
  -- Timestamps
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.risk_scores ENABLE ROW LEVEL SECURITY;

-- 9. FLAGS TABLE (PENDING HUMAN REVIEW)
-- =============================================
CREATE TABLE public.flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES public.accounts(id) ON DELETE CASCADE NOT NULL,
  flag_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status public.flag_status NOT NULL DEFAULT 'pending',
  -- Review tracking
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  escalated_to UUID REFERENCES auth.users(id),
  escalated_at TIMESTAMPTZ
);

ALTER TABLE public.flags ENABLE ROW LEVEL SECURITY;

-- 10. AUDIT LOGS TABLE (IMMUTABLE)
-- =============================================
CREATE TABLE public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  account_id UUID REFERENCES public.accounts(id),
  action public.audit_action NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- 11. PAYOUTS TABLE
-- =============================================
CREATE TABLE public.payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES public.accounts(id) ON DELETE CASCADE NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  status public.payout_status NOT NULL DEFAULT 'pending',
  -- Review tracking
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  -- Payment details
  paid_at TIMESTAMPTZ,
  payment_reference TEXT
);

ALTER TABLE public.payouts ENABLE ROW LEVEL SECURITY;

-- 12. SYSTEM SETTINGS TABLE (FOR INTAKE CONTROL)
-- =============================================
CREATE TABLE public.system_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id)
);

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

-- Insert default intake setting
INSERT INTO public.system_settings (key, value) VALUES ('global_intake_active', 'true');

-- =============================================
-- SECURITY DEFINER FUNCTIONS
-- =============================================

-- Function to check if user has a specific role
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
$$;

-- Function to check if user has any of multiple roles
CREATE OR REPLACE FUNCTION public.has_any_role(_user_id UUID, _roles public.app_role[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = ANY(_roles)
  )
$$;

-- Function to get user's roles
CREATE OR REPLACE FUNCTION public.get_user_roles(_user_id UUID)
RETURNS public.app_role[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(role), ARRAY[]::public.app_role[])
  FROM public.user_roles
  WHERE user_id = _user_id
$$;

-- =============================================
-- ROW LEVEL SECURITY POLICIES
-- =============================================

-- PROFILES POLICIES
CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own profile"
  ON public.profiles FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Staff can view all profiles"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['risk_officer', 'support', 'admin']::public.app_role[]));

-- USER ROLES POLICIES
CREATE POLICY "Users can view own roles"
  ON public.user_roles FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Admins can manage roles"
  ON public.user_roles FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- COHORTS POLICIES
CREATE POLICY "Anyone authenticated can view active cohorts"
  ON public.cohorts FOR SELECT
  TO authenticated
  USING (is_active = true);

CREATE POLICY "Admins can manage cohorts"
  ON public.cohorts FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- ACCOUNTS POLICIES
CREATE POLICY "Traders can view own accounts"
  ON public.accounts FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Traders can insert own accounts"
  ON public.accounts FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Staff can view all accounts"
  ON public.accounts FOR SELECT
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['risk_officer', 'support', 'admin']::public.app_role[]));

CREATE POLICY "Admins can update accounts"
  ON public.accounts FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- TRADES POLICIES
CREATE POLICY "Traders can view own trades"
  ON public.trades FOR SELECT
  TO authenticated
  USING (
    account_id IN (
      SELECT id FROM public.accounts WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Traders can insert own trades"
  ON public.trades FOR INSERT
  TO authenticated
  WITH CHECK (
    account_id IN (
      SELECT id FROM public.accounts WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Staff can view all trades"
  ON public.trades FOR SELECT
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['risk_officer', 'support', 'admin']::public.app_role[]));

-- VIOLATIONS POLICIES
CREATE POLICY "Traders can view own violations"
  ON public.violations FOR SELECT
  TO authenticated
  USING (
    account_id IN (
      SELECT id FROM public.accounts WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Staff can view all violations"
  ON public.violations FOR SELECT
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['risk_officer', 'support', 'admin']::public.app_role[]));

CREATE POLICY "Staff can manage violations"
  ON public.violations FOR ALL
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['risk_officer', 'admin']::public.app_role[]));

-- RISK SCORES POLICIES
CREATE POLICY "Traders can view own risk scores"
  ON public.risk_scores FOR SELECT
  TO authenticated
  USING (
    account_id IN (
      SELECT id FROM public.accounts WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Staff can view all risk scores"
  ON public.risk_scores FOR SELECT
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['risk_officer', 'support', 'admin']::public.app_role[]));

CREATE POLICY "System can manage risk scores"
  ON public.risk_scores FOR ALL
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['risk_officer', 'admin']::public.app_role[]));

-- FLAGS POLICIES
CREATE POLICY "Traders can view own flags"
  ON public.flags FOR SELECT
  TO authenticated
  USING (
    account_id IN (
      SELECT id FROM public.accounts WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Staff can view all flags"
  ON public.flags FOR SELECT
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['risk_officer', 'support', 'admin']::public.app_role[]));

CREATE POLICY "Staff can manage flags"
  ON public.flags FOR ALL
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['risk_officer', 'admin']::public.app_role[]));

-- AUDIT LOGS POLICIES (READ-ONLY FOR STAFF)
CREATE POLICY "Staff can view audit logs"
  ON public.audit_logs FOR SELECT
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['risk_officer', 'support', 'admin']::public.app_role[]));

CREATE POLICY "System can insert audit logs"
  ON public.audit_logs FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- PAYOUTS POLICIES
CREATE POLICY "Traders can view own payouts"
  ON public.payouts FOR SELECT
  TO authenticated
  USING (
    account_id IN (
      SELECT id FROM public.accounts WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Traders can request payouts"
  ON public.payouts FOR INSERT
  TO authenticated
  WITH CHECK (
    account_id IN (
      SELECT id FROM public.accounts WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Staff can view all payouts"
  ON public.payouts FOR SELECT
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['risk_officer', 'support', 'admin']::public.app_role[]));

CREATE POLICY "Admins can manage payouts"
  ON public.payouts FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- SYSTEM SETTINGS POLICIES
CREATE POLICY "Staff can view settings"
  ON public.system_settings FOR SELECT
  TO authenticated
  USING (public.has_any_role(auth.uid(), ARRAY['risk_officer', 'support', 'admin']::public.app_role[]));

CREATE POLICY "Admins can manage settings"
  ON public.system_settings FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- =============================================
-- TRIGGERS
-- =============================================

-- Updated at trigger function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at triggers
CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_accounts_updated_at
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_risk_scores_updated_at
  BEFORE UPDATE ON public.risk_scores
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_system_settings_updated_at
  BEFORE UPDATE ON public.system_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Auto-create profile on user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email)
  );
  
  -- Assign default 'trader' role to new users
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'trader');
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Create default cohort
INSERT INTO public.cohorts (name, description, version)
VALUES ('Standard Challenge', 'Default trading challenge with standard rules', 1);