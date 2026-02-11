
ALTER TABLE public.accounts DISABLE TRIGGER trg_breaker_block_account_create;
ALTER TABLE public.accounts DISABLE TRIGGER trg_account_breaker_eval;
ALTER TABLE public.payouts DISABLE TRIGGER trg_breaker_enforce_payout_status;
ALTER TABLE public.payouts DISABLE TRIGGER trg_breaker_enforce_payout_status_insert;
ALTER TABLE public.payouts DISABLE TRIGGER trg_payout_breaker_eval_insert;
ALTER TABLE public.payouts DISABLE TRIGGER trg_payout_breaker_eval_update;
ALTER TABLE public.payouts DISABLE TRIGGER guard_payout_immutable;

DO $$
DECLARE
  _uid uuid := '65c43a0a-7182-448f-9753-ed9818030602';
  _eval_cid uuid := '30c85b00-c613-4d33-83e5-c5af8a8ea6d5';
  _veri_cid uuid := '1d28f164-3219-4c05-879d-a2642c15a57e';
  _perf_cid uuid := 'e2965581-ada0-4895-be32-4e6d984ea362';
  _prefix text := 'DEMO-';
  _aid uuid; _paid_aid uuid;
BEGIN
  DELETE FROM public.payouts p USING public.accounts a WHERE p.account_id=a.id AND a.user_id=_uid AND a.account_number LIKE _prefix||'%';
  DELETE FROM public.account_daily_stats ds USING public.accounts a WHERE ds.account_id=a.id AND a.user_id=_uid AND a.account_number LIKE _prefix||'%';
  DELETE FROM public.flags f USING public.accounts a WHERE f.account_id=a.id AND a.user_id=_uid AND a.account_number LIKE _prefix||'%';
  DELETE FROM public.accounts WHERE user_id=_uid AND account_number LIKE _prefix||'%';
  DELETE FROM public.user_cohort_payouts WHERE user_id=_uid;

  INSERT INTO public.accounts (user_id,cohort_id,account_number,status,starting_balance,current_balance,highest_balance,total_pnl,daily_pnl,trading_days_count,payout_cycle_start_balance,created_at) VALUES (_uid,_eval_cid,_prefix||'EVAL-NEAR-PASS','active',100000,109500,109800,9500,450,8,100000,now()-interval '20 days');
  INSERT INTO public.accounts (user_id,cohort_id,account_number,status,starting_balance,current_balance,highest_balance,total_pnl,daily_pnl,trading_days_count,payout_cycle_start_balance,created_at) VALUES (_uid,_eval_cid,_prefix||'EVAL-BREACH','breached_detected',100000,94200,101500,-5800,-5800,6,100000,now()-interval '15 days') RETURNING id INTO _aid;
  INSERT INTO public.flags (account_id,flag_type,reason,severity,status) VALUES (_aid,'daily_loss_breach','Daily PnL -$5,800 exceeds 5% limit','high','pending');
  INSERT INTO public.accounts (user_id,cohort_id,account_number,status,starting_balance,current_balance,highest_balance,total_pnl,daily_pnl,trading_days_count,failed_at,payout_cycle_start_balance,created_at) VALUES (_uid,_eval_cid,_prefix||'EVAL-FAILED','failed_confirmed',100000,89500,102000,-10500,-3200,11,now()-interval '3 days',100000,now()-interval '25 days');
  INSERT INTO public.accounts (user_id,cohort_id,account_number,status,starting_balance,current_balance,highest_balance,total_pnl,daily_pnl,trading_days_count,passed_at,payout_cycle_start_balance,payout_cycle_started_at,created_at) VALUES (_uid,_eval_cid,_prefix||'EVAL-PASSED-COOLING','passed',100000,110500,111200,10500,280,9,now()-interval '3 days',100000,now()-interval '3 days',now()-interval '30 days');
  INSERT INTO public.accounts (user_id,cohort_id,account_number,status,starting_balance,current_balance,highest_balance,total_pnl,daily_pnl,trading_days_count,passed_at,payout_cycle_start_balance,payout_cycle_started_at,created_at) VALUES (_uid,_eval_cid,_prefix||'EVAL-PASSED-READY','passed',100000,112000,112500,12000,600,14,now()-interval '14 days',100000,now()-interval '14 days',now()-interval '45 days');
  INSERT INTO public.accounts (user_id,cohort_id,account_number,status,starting_balance,current_balance,highest_balance,total_pnl,daily_pnl,trading_days_count,phase_index,payout_cycle_start_balance,created_at) VALUES (_uid,_veri_cid,_prefix||'VERI-ACTIVE','active',100000,103200,103800,3200,150,7,1,100000,now()-interval '18 days');
  INSERT INTO public.accounts (user_id,cohort_id,account_number,status,starting_balance,current_balance,highest_balance,total_pnl,daily_pnl,trading_days_count,phase_index,passed_at,payout_cycle_start_balance,payout_cycle_started_at,created_at) VALUES (_uid,_veri_cid,_prefix||'VERI-PASSED','passed',100000,106200,106800,6200,310,12,1,now()-interval '5 days',100000,now()-interval '5 days',now()-interval '35 days');
  INSERT INTO public.accounts (user_id,cohort_id,account_number,status,starting_balance,current_balance,highest_balance,total_pnl,daily_pnl,trading_days_count,phase_index,passed_at,payout_cycle_start_balance,payout_cycle_started_at,created_at) VALUES (_uid,_perf_cid,_prefix||'PERF-ELIGIBLE','passed',100000,102800,103200,2800,180,20,2,now()-interval '21 days',100000,now()-interval '21 days',now()-interval '60 days');
  INSERT INTO public.accounts (user_id,cohort_id,account_number,status,starting_balance,current_balance,highest_balance,total_pnl,daily_pnl,trading_days_count,phase_index,passed_at,payout_cycle_start_balance,payout_cycle_started_at,created_at) VALUES (_uid,_perf_cid,_prefix||'PERF-PAYOUT-REQ','payout_requested',100000,104500,105100,4500,220,25,2,now()-interval '30 days',100000,now()-interval '30 days',now()-interval '75 days') RETURNING id INTO _aid;
  INSERT INTO public.payouts (account_id,amount,status,requested_at,calculated_eligible_amount) VALUES (_aid,300,'pending'::payout_status,now()-interval '1 day',300);
  INSERT INTO public.accounts (user_id,cohort_id,account_number,status,starting_balance,current_balance,highest_balance,total_pnl,daily_pnl,trading_days_count,phase_index,passed_at,payout_cycle_start_balance,payout_cycle_started_at,created_at) VALUES (_uid,_perf_cid,_prefix||'PERF-NEAR-CAP','passed',100000,103500,108000,3500,400,35,2,now()-interval '60 days',102500,now()-interval '15 days',now()-interval '120 days') RETURNING id INTO _paid_aid;
  INSERT INTO public.payouts (account_id,amount,status,requested_at,reviewed_at,reviewed_by,approved_by,paid_at,paid_by,payment_reference,calculated_eligible_amount) VALUES
    (_paid_aid,300,'paid'::payout_status,now()-interval '50 days',now()-interval '49 days',_uid,_uid,now()-interval '48 days',_uid,'DEMO-PAY-001',300),
    (_paid_aid,300,'paid'::payout_status,now()-interval '35 days',now()-interval '34 days',_uid,_uid,now()-interval '33 days',_uid,'DEMO-PAY-002',300),
    (_paid_aid,300,'paid'::payout_status,now()-interval '20 days',now()-interval '19 days',_uid,_uid,now()-interval '18 days',_uid,'DEMO-PAY-003',300);
  INSERT INTO public.user_cohort_payouts (user_id,cohort_id,lifetime_paid_total) VALUES (_uid,_perf_cid,900) ON CONFLICT (user_id,cohort_id) DO UPDATE SET lifetime_paid_total=900;
  UPDATE public.profiles SET lifetime_paid_total=900 WHERE user_id=_uid;
  INSERT INTO public.accounts (user_id,cohort_id,account_number,status,starting_balance,current_balance,highest_balance,total_pnl,daily_pnl,trading_days_count,phase_index,passed_at,payout_cycle_start_balance,payout_cycle_started_at,created_at) VALUES (_uid,_perf_cid,_prefix||'PERF-BESTDAY-ISSUE','active',100000,103000,103500,3000,1600,8,2,now()-interval '25 days',100000,now()-interval '25 days',now()-interval '50 days') RETURNING id INTO _aid;
  INSERT INTO public.account_daily_stats (account_id,trading_day,gross_pnl,net_pnl,trade_count,winning_trades,losing_trades) VALUES
    (_aid,current_date-7,400,380,4,3,1),(_aid,current_date-6,-200,-220,3,1,2),
    (_aid,current_date-5,300,280,5,3,2),(_aid,current_date-4,1600,1570,6,5,1),
    (_aid,current_date-3,150,130,2,2,0),(_aid,current_date-2,500,480,4,3,1),
    (_aid,current_date-1,100,80,3,2,1),(_aid,current_date,150,130,2,1,1);
  INSERT INTO public.flags (account_id,flag_type,reason,severity,status) VALUES (_aid,'best_day_cap','Best day 53% of profit exceeds 40% cap','medium','pending');
  INSERT INTO public.accounts (user_id,cohort_id,account_number,status,starting_balance,current_balance,highest_balance,total_pnl,daily_pnl,trading_days_count,payout_cycle_start_balance,created_at) VALUES (_uid,_eval_cid,_prefix||'EVAL-DRAWDOWN-RISK','active',100000,91000,103000,-9000,-1200,15,100000,now()-interval '22 days') RETURNING id INTO _aid;
  INSERT INTO public.flags (account_id,flag_type,reason,severity,status) VALUES (_aid,'drawdown_warning','Account at 9% drawdown, 1% from 10% max','high','pending');
END $$;

ALTER TABLE public.accounts ENABLE TRIGGER trg_breaker_block_account_create;
ALTER TABLE public.accounts ENABLE TRIGGER trg_account_breaker_eval;
ALTER TABLE public.payouts ENABLE TRIGGER trg_breaker_enforce_payout_status;
ALTER TABLE public.payouts ENABLE TRIGGER trg_breaker_enforce_payout_status_insert;
ALTER TABLE public.payouts ENABLE TRIGGER trg_payout_breaker_eval_insert;
ALTER TABLE public.payouts ENABLE TRIGGER trg_payout_breaker_eval_update;
ALTER TABLE public.payouts ENABLE TRIGGER guard_payout_immutable;
UPDATE public.econ_breaker_state SET breaker_level='normal',evaluations_frozen=false,approvals_blocked=false,payouts_blocked=false,triggered_by='seed_reset',updated_at=now() WHERE id='00000000-0000-0000-0000-000000000001';
