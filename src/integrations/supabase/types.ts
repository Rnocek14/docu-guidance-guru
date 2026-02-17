export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      account_daily_stats: {
        Row: {
          account_id: string
          commissions: number
          created_at: string
          gross_pnl: number
          id: string
          is_winning_day: boolean
          losing_trades: number
          net_pnl: number
          trade_count: number
          trading_day: string
          updated_at: string
          winning_trades: number
        }
        Insert: {
          account_id: string
          commissions?: number
          created_at?: string
          gross_pnl?: number
          id?: string
          is_winning_day?: boolean
          losing_trades?: number
          net_pnl?: number
          trade_count?: number
          trading_day: string
          updated_at?: string
          winning_trades?: number
        }
        Update: {
          account_id?: string
          commissions?: number
          created_at?: string
          gross_pnl?: number
          id?: string
          is_winning_day?: boolean
          losing_trades?: number
          net_pnl?: number
          trade_count?: number
          trading_day?: string
          updated_at?: string
          winning_trades?: number
        }
        Relationships: [
          {
            foreignKeyName: "account_daily_stats_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      account_events: {
        Row: {
          account_id: string
          created_at: string
          event_data: Json
          event_type: Database["public"]["Enums"]["account_event_type"]
          id: string
          idempotency_key: string
          request_id: string | null
        }
        Insert: {
          account_id: string
          created_at?: string
          event_data?: Json
          event_type: Database["public"]["Enums"]["account_event_type"]
          id?: string
          idempotency_key: string
          request_id?: string | null
        }
        Update: {
          account_id?: string
          created_at?: string
          event_data?: Json
          event_type?: Database["public"]["Enums"]["account_event_type"]
          id?: string
          idempotency_key?: string
          request_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "account_events_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      account_phase_transitions: {
        Row: {
          created_at: string
          from_account_id: string
          from_cohort_id: string
          id: string
          to_account_id: string
          to_cohort_id: string
        }
        Insert: {
          created_at?: string
          from_account_id: string
          from_cohort_id: string
          id?: string
          to_account_id: string
          to_cohort_id: string
        }
        Update: {
          created_at?: string
          from_account_id?: string
          from_cohort_id?: string
          id?: string
          to_account_id?: string
          to_cohort_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_phase_transitions_from_account_id_fkey"
            columns: ["from_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_phase_transitions_from_cohort_id_fkey"
            columns: ["from_cohort_id"]
            isOneToOne: false
            referencedRelation: "cohorts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_phase_transitions_to_account_id_fkey"
            columns: ["to_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_phase_transitions_to_cohort_id_fkey"
            columns: ["to_cohort_id"]
            isOneToOne: false
            referencedRelation: "cohorts"
            referencedColumns: ["id"]
          },
        ]
      }
      accounts: {
        Row: {
          account_number: string
          cohort_id: string
          created_at: string
          current_balance: number
          daily_pnl: number
          daily_pnl_start_balance: number | null
          daily_reset_at: string | null
          disabled_at: string | null
          external_account_id: string | null
          external_provider: string | null
          external_status: string | null
          external_user_id: string | null
          failed_at: string | null
          highest_balance: number
          id: string
          last_trade_at: string | null
          parent_account_id: string | null
          passed_at: string | null
          payout_cycle_start_balance: number | null
          payout_cycle_started_at: string | null
          phase_index: number
          provider_metadata: Json | null
          provisioned_at: string | null
          root_account_id: string | null
          rule_snapshot: Json | null
          starting_balance: number
          status: Database["public"]["Enums"]["account_status"]
          stripe_session_id: string | null
          total_pnl: number
          trading_days_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          account_number: string
          cohort_id: string
          created_at?: string
          current_balance?: number
          daily_pnl?: number
          daily_pnl_start_balance?: number | null
          daily_reset_at?: string | null
          disabled_at?: string | null
          external_account_id?: string | null
          external_provider?: string | null
          external_status?: string | null
          external_user_id?: string | null
          failed_at?: string | null
          highest_balance?: number
          id?: string
          last_trade_at?: string | null
          parent_account_id?: string | null
          passed_at?: string | null
          payout_cycle_start_balance?: number | null
          payout_cycle_started_at?: string | null
          phase_index?: number
          provider_metadata?: Json | null
          provisioned_at?: string | null
          root_account_id?: string | null
          rule_snapshot?: Json | null
          starting_balance?: number
          status?: Database["public"]["Enums"]["account_status"]
          stripe_session_id?: string | null
          total_pnl?: number
          trading_days_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          account_number?: string
          cohort_id?: string
          created_at?: string
          current_balance?: number
          daily_pnl?: number
          daily_pnl_start_balance?: number | null
          daily_reset_at?: string | null
          disabled_at?: string | null
          external_account_id?: string | null
          external_provider?: string | null
          external_status?: string | null
          external_user_id?: string | null
          failed_at?: string | null
          highest_balance?: number
          id?: string
          last_trade_at?: string | null
          parent_account_id?: string | null
          passed_at?: string | null
          payout_cycle_start_balance?: number | null
          payout_cycle_started_at?: string | null
          phase_index?: number
          provider_metadata?: Json | null
          provisioned_at?: string | null
          root_account_id?: string | null
          rule_snapshot?: Json | null
          starting_balance?: number
          status?: Database["public"]["Enums"]["account_status"]
          stripe_session_id?: string | null
          total_pnl?: number
          trading_days_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "accounts_cohort_id_fkey"
            columns: ["cohort_id"]
            isOneToOne: false
            referencedRelation: "cohorts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "accounts_parent_account_id_fkey"
            columns: ["parent_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "accounts_root_account_id_fkey"
            columns: ["root_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_usage_log: {
        Row: {
          ai_status: string
          completion_tokens: number
          created_at: string
          error: string | null
          estimated_cost_cents: number
          function_name: string
          id: string
          latency_ms: number | null
          model: string
          prompt_tokens: number
          support_email_id: string | null
          total_tokens: number
        }
        Insert: {
          ai_status?: string
          completion_tokens?: number
          created_at?: string
          error?: string | null
          estimated_cost_cents?: number
          function_name: string
          id?: string
          latency_ms?: number | null
          model: string
          prompt_tokens?: number
          support_email_id?: string | null
          total_tokens?: number
        }
        Update: {
          ai_status?: string
          completion_tokens?: number
          created_at?: string
          error?: string | null
          estimated_cost_cents?: number
          function_name?: string
          id?: string
          latency_ms?: number | null
          model?: string
          prompt_tokens?: number
          support_email_id?: string | null
          total_tokens?: number
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_log_support_email_id_fkey"
            columns: ["support_email_id"]
            isOneToOne: false
            referencedRelation: "support_emails"
            referencedColumns: ["id"]
          },
        ]
      }
      analytics_events: {
        Row: {
          created_at: string
          event: string
          id: string
          path: string | null
          props: Json
          session_id: string
          user_id: string | null
          utm_campaign: string | null
          utm_content: string | null
          utm_medium: string | null
          utm_source: string | null
        }
        Insert: {
          created_at?: string
          event: string
          id?: string
          path?: string | null
          props?: Json
          session_id: string
          user_id?: string | null
          utm_campaign?: string | null
          utm_content?: string | null
          utm_medium?: string | null
          utm_source?: string | null
        }
        Update: {
          created_at?: string
          event?: string
          id?: string
          path?: string | null
          props?: Json
          session_id?: string
          user_id?: string | null
          utm_campaign?: string | null
          utm_content?: string | null
          utm_medium?: string | null
          utm_source?: string | null
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          account_id: string | null
          action: Database["public"]["Enums"]["audit_action"]
          created_at: string
          details: Json
          id: string
          idempotency_key: string
          ip_address: string | null
          prev_hash: string
          reason: string | null
          request_id: string | null
          row_hash: string
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          account_id?: string | null
          action: Database["public"]["Enums"]["audit_action"]
          created_at?: string
          details?: Json
          id?: string
          idempotency_key: string
          ip_address?: string | null
          prev_hash: string
          reason?: string | null
          request_id?: string | null
          row_hash: string
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          account_id?: string | null
          action?: Database["public"]["Enums"]["audit_action"]
          created_at?: string
          details?: Json
          id?: string
          idempotency_key?: string
          ip_address?: string | null
          prev_hash?: string
          reason?: string | null
          request_id?: string | null
          row_hash?: string
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      broker_payload_samples: {
        Row: {
          broker: string
          created_at: string
          headers_subset: Json
          id: string
          notes: string | null
          raw_body: string
          raw_hash: string
          request_id: string
        }
        Insert: {
          broker: string
          created_at?: string
          headers_subset?: Json
          id?: string
          notes?: string | null
          raw_body: string
          raw_hash: string
          request_id: string
        }
        Update: {
          broker?: string
          created_at?: string
          headers_subset?: Json
          id?: string
          notes?: string | null
          raw_body?: string
          raw_hash?: string
          request_id?: string
        }
        Relationships: []
      }
      chargeback_events: {
        Row: {
          amount: number
          auto_freeze_applied: boolean
          card_fingerprint: string | null
          country: string | null
          created_at: string
          currency: string
          freeze_action_id: string | null
          id: string
          ip: unknown
          notes: string | null
          occurred_at: string
          payment_method_fingerprint: string | null
          payment_txn_id: string | null
          provider: string
          provider_dispute_id: string | null
          provider_event_id: string
          reason_code: string | null
          stage: string
          updated_at: string
          user_id: string
        }
        Insert: {
          amount?: number
          auto_freeze_applied?: boolean
          card_fingerprint?: string | null
          country?: string | null
          created_at?: string
          currency?: string
          freeze_action_id?: string | null
          id?: string
          ip?: unknown
          notes?: string | null
          occurred_at: string
          payment_method_fingerprint?: string | null
          payment_txn_id?: string | null
          provider: string
          provider_dispute_id?: string | null
          provider_event_id: string
          reason_code?: string | null
          stage: string
          updated_at?: string
          user_id: string
        }
        Update: {
          amount?: number
          auto_freeze_applied?: boolean
          card_fingerprint?: string | null
          country?: string | null
          created_at?: string
          currency?: string
          freeze_action_id?: string | null
          id?: string
          ip?: unknown
          notes?: string | null
          occurred_at?: string
          payment_method_fingerprint?: string | null
          payment_txn_id?: string | null
          provider?: string
          provider_dispute_id?: string | null
          provider_event_id?: string
          reason_code?: string | null
          stage?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chargeback_events_payment_txn_id_fkey"
            columns: ["payment_txn_id"]
            isOneToOne: false
            referencedRelation: "payment_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      checkout_fulfillment_queue: {
        Row: {
          amount_cents: number | null
          attempts: number
          created_at: string
          currency: string | null
          fulfilled_account_id: string | null
          id: string
          last_error: string | null
          payment_intent: string | null
          processing_started_at: string | null
          provider: string | null
          provider_event_id: string | null
          provider_payment_id: string | null
          provider_session_id: string
          rail_key: string | null
          rules_acknowledged: boolean
          rules_acknowledged_at: string | null
          rules_version: string
          status: string
          stripe_session_id: string
          tier_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          amount_cents?: number | null
          attempts?: number
          created_at?: string
          currency?: string | null
          fulfilled_account_id?: string | null
          id?: string
          last_error?: string | null
          payment_intent?: string | null
          processing_started_at?: string | null
          provider?: string | null
          provider_event_id?: string | null
          provider_payment_id?: string | null
          provider_session_id: string
          rail_key?: string | null
          rules_acknowledged?: boolean
          rules_acknowledged_at?: string | null
          rules_version?: string
          status?: string
          stripe_session_id: string
          tier_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          amount_cents?: number | null
          attempts?: number
          created_at?: string
          currency?: string | null
          fulfilled_account_id?: string | null
          id?: string
          last_error?: string | null
          payment_intent?: string | null
          processing_started_at?: string | null
          provider?: string | null
          provider_event_id?: string | null
          provider_payment_id?: string | null
          provider_session_id?: string
          rail_key?: string | null
          rules_acknowledged?: boolean
          rules_acknowledged_at?: string | null
          rules_version?: string
          status?: string
          stripe_session_id?: string
          tier_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "checkout_fulfillment_queue_fulfilled_account_id_fkey"
            columns: ["fulfilled_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      cohorts: {
        Row: {
          cohort_phase: string
          created_at: string
          created_by: string | null
          description: string | null
          entry_fee: number | null
          first_payout_cap_amount: number | null
          id: string
          intake_active: boolean
          is_active: boolean
          lifetime_cap_multiple: number | null
          max_daily_loss_percent: number
          max_daily_profit_cap_percent: number | null
          max_payout_absolute: number | null
          max_payout_percent: number
          max_position_size_percent: number
          max_total_drawdown_percent: number
          min_profit_buffer: number | null
          min_profitable_days: number
          min_trading_days: number
          min_trading_days_between_payouts: number
          min_winning_days_between_payouts: number | null
          name: string
          next_cohort_id: string | null
          payout_cooldown_days: number
          payout_eligibility_delay_days: number
          payout_split_percent: number
          profit_target_percent: number
          tier_id: string | null
          version: number
        }
        Insert: {
          cohort_phase?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          entry_fee?: number | null
          first_payout_cap_amount?: number | null
          id?: string
          intake_active?: boolean
          is_active?: boolean
          lifetime_cap_multiple?: number | null
          max_daily_loss_percent?: number
          max_daily_profit_cap_percent?: number | null
          max_payout_absolute?: number | null
          max_payout_percent?: number
          max_position_size_percent?: number
          max_total_drawdown_percent?: number
          min_profit_buffer?: number | null
          min_profitable_days?: number
          min_trading_days?: number
          min_trading_days_between_payouts?: number
          min_winning_days_between_payouts?: number | null
          name: string
          next_cohort_id?: string | null
          payout_cooldown_days?: number
          payout_eligibility_delay_days?: number
          payout_split_percent?: number
          profit_target_percent?: number
          tier_id?: string | null
          version?: number
        }
        Update: {
          cohort_phase?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          entry_fee?: number | null
          first_payout_cap_amount?: number | null
          id?: string
          intake_active?: boolean
          is_active?: boolean
          lifetime_cap_multiple?: number | null
          max_daily_loss_percent?: number
          max_daily_profit_cap_percent?: number | null
          max_payout_absolute?: number | null
          max_payout_percent?: number
          max_position_size_percent?: number
          max_total_drawdown_percent?: number
          min_profit_buffer?: number | null
          min_profitable_days?: number
          min_trading_days?: number
          min_trading_days_between_payouts?: number
          min_winning_days_between_payouts?: number | null
          name?: string
          next_cohort_id?: string | null
          payout_cooldown_days?: number
          payout_eligibility_delay_days?: number
          payout_split_percent?: number
          profit_target_percent?: number
          tier_id?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "cohorts_next_cohort_id_fkey"
            columns: ["next_cohort_id"]
            isOneToOne: false
            referencedRelation: "cohorts"
            referencedColumns: ["id"]
          },
        ]
      }
      cron_health_config: {
        Row: {
          created_at: string
          enabled: boolean
          expected_interval: unknown
          jobname: string
          min_expected_runs: number
          red_if_success_rate_below: number
          updated_at: string
          yellow_if_success_rate_below: number
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          expected_interval: unknown
          jobname: string
          min_expected_runs: number
          red_if_success_rate_below?: number
          updated_at?: string
          yellow_if_success_rate_below?: number
        }
        Update: {
          created_at?: string
          enabled?: boolean
          expected_interval?: unknown
          jobname?: string
          min_expected_runs?: number
          red_if_success_rate_below?: number
          updated_at?: string
          yellow_if_success_rate_below?: number
        }
        Relationships: []
      }
      cron_http_runs: {
        Row: {
          http_content: string | null
          http_status: number | null
          id: number
          jobname: string
          ran_at: string
        }
        Insert: {
          http_content?: string | null
          http_status?: number | null
          id?: number
          jobname: string
          ran_at?: string
        }
        Update: {
          http_content?: string | null
          http_status?: number | null
          id?: number
          jobname?: string
          ran_at?: string
        }
        Relationships: []
      }
      device_fingerprints: {
        Row: {
          asn: string | null
          cluster_id: string | null
          country_code: string | null
          fingerprint_components: Json
          fingerprint_hash: string
          first_seen_at: string
          id: string
          ip_address: unknown
          is_vpn: boolean | null
          last_seen_at: string
          seen_count: number
          user_id: string
        }
        Insert: {
          asn?: string | null
          cluster_id?: string | null
          country_code?: string | null
          fingerprint_components?: Json
          fingerprint_hash: string
          first_seen_at?: string
          id?: string
          ip_address?: unknown
          is_vpn?: boolean | null
          last_seen_at?: string
          seen_count?: number
          user_id: string
        }
        Update: {
          asn?: string | null
          cluster_id?: string | null
          country_code?: string | null
          fingerprint_components?: Json
          fingerprint_hash?: string
          first_seen_at?: string
          id?: string
          ip_address?: unknown
          is_vpn?: boolean | null
          last_seen_at?: string
          seen_count?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_fingerprints_cluster_id_fkey"
            columns: ["cluster_id"]
            isOneToOne: false
            referencedRelation: "identity_clusters"
            referencedColumns: ["id"]
          },
        ]
      }
      econ_breaker_state: {
        Row: {
          approvals_blocked: boolean
          breaker_level: string
          evaluations_frozen: boolean
          id: string
          last_evaluated_at: string
          net_buffer: number | null
          payouts_blocked: boolean
          pending_liability: number
          previous_level: string | null
          rolling_pass_count: number
          rolling_pass_rate: number
          rolling_total_count: number
          triggered_by: string | null
          updated_at: string
        }
        Insert: {
          approvals_blocked?: boolean
          breaker_level?: string
          evaluations_frozen?: boolean
          id?: string
          last_evaluated_at?: string
          net_buffer?: number | null
          payouts_blocked?: boolean
          pending_liability?: number
          previous_level?: string | null
          rolling_pass_count?: number
          rolling_pass_rate?: number
          rolling_total_count?: number
          triggered_by?: string | null
          updated_at?: string
        }
        Update: {
          approvals_blocked?: boolean
          breaker_level?: string
          evaluations_frozen?: boolean
          id?: string
          last_evaluated_at?: string
          net_buffer?: number | null
          payouts_blocked?: boolean
          pending_liability?: number
          previous_level?: string | null
          rolling_pass_count?: number
          rolling_pass_rate?: number
          rolling_total_count?: number
          triggered_by?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      flags: {
        Row: {
          account_id: string
          created_at: string
          escalated_at: string | null
          escalated_to: string | null
          flag_type: string
          id: string
          reason: string
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          severity: string
          status: Database["public"]["Enums"]["flag_status"]
        }
        Insert: {
          account_id: string
          created_at?: string
          escalated_at?: string | null
          escalated_to?: string | null
          flag_type: string
          id?: string
          reason: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          severity?: string
          status?: Database["public"]["Enums"]["flag_status"]
        }
        Update: {
          account_id?: string
          created_at?: string
          escalated_at?: string | null
          escalated_to?: string | null
          flag_type?: string
          id?: string
          reason?: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          severity?: string
          status?: Database["public"]["Enums"]["flag_status"]
        }
        Relationships: [
          {
            foreignKeyName: "flags_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      fraud_reviews: {
        Row: {
          assigned_to: string | null
          auto_block: boolean
          created_at: string
          details: Json
          entity_id: string
          entity_type: string
          id: string
          request_id: string | null
          review_notes: string | null
          review_type: string
          reviewed_at: string | null
          reviewed_by: string | null
          severity: string
          status: string
        }
        Insert: {
          assigned_to?: string | null
          auto_block?: boolean
          created_at?: string
          details?: Json
          entity_id: string
          entity_type: string
          id?: string
          request_id?: string | null
          review_notes?: string | null
          review_type: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          severity?: string
          status?: string
        }
        Update: {
          assigned_to?: string | null
          auto_block?: boolean
          created_at?: string
          details?: Json
          entity_id?: string
          entity_type?: string
          id?: string
          request_id?: string | null
          review_notes?: string | null
          review_type?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          severity?: string
          status?: string
        }
        Relationships: []
      }
      geo_signals: {
        Row: {
          confidence: number
          country_code: string
          id: string
          metadata: Json
          observed_at: string
          signal_type: string
          source: string | null
          user_id: string
        }
        Insert: {
          confidence?: number
          country_code: string
          id?: string
          metadata?: Json
          observed_at?: string
          signal_type: string
          source?: string | null
          user_id: string
        }
        Update: {
          confidence?: number
          country_code?: string
          id?: string
          metadata?: Json
          observed_at?: string
          signal_type?: string
          source?: string | null
          user_id?: string
        }
        Relationships: []
      }
      identity_clusters: {
        Row: {
          cluster_name: string | null
          created_at: string
          flag_reason: string | null
          id: string
          is_flagged: boolean
          risk_score: number
          updated_at: string
        }
        Insert: {
          cluster_name?: string | null
          created_at?: string
          flag_reason?: string | null
          id?: string
          is_flagged?: boolean
          risk_score?: number
          updated_at?: string
        }
        Update: {
          cluster_name?: string | null
          created_at?: string
          flag_reason?: string | null
          id?: string
          is_flagged?: boolean
          risk_score?: number
          updated_at?: string
        }
        Relationships: []
      }
      instrument_correlation_groups: {
        Row: {
          created_at: string
          group_name: string
          id: string
          is_active: boolean
          symbols: string[]
        }
        Insert: {
          created_at?: string
          group_name: string
          id?: string
          is_active?: boolean
          symbols: string[]
        }
        Update: {
          created_at?: string
          group_name?: string
          id?: string
          is_active?: boolean
          symbols?: string[]
        }
        Relationships: []
      }
      internal_secrets: {
        Row: {
          created_at: string
          key: string
          updated_at: string
          value: string
        }
        Insert: {
          created_at?: string
          key: string
          updated_at?: string
          value: string
        }
        Update: {
          created_at?: string
          key?: string
          updated_at?: string
          value?: string
        }
        Relationships: []
      }
      jurisdiction_rules: {
        Row: {
          allow_evaluation: boolean
          allow_funded_sim: boolean
          allow_payouts: boolean
          country_code: string
          created_at: string
          disclosure_version: string
          id: string
          is_allowed: boolean
          reason: string | null
          require_kyc_before_payout: boolean
          require_kyc_before_trading: boolean
          require_market_data_attestation: boolean
          terms_version: string
          updated_at: string
        }
        Insert: {
          allow_evaluation?: boolean
          allow_funded_sim?: boolean
          allow_payouts?: boolean
          country_code: string
          created_at?: string
          disclosure_version?: string
          id?: string
          is_allowed?: boolean
          reason?: string | null
          require_kyc_before_payout?: boolean
          require_kyc_before_trading?: boolean
          require_market_data_attestation?: boolean
          terms_version?: string
          updated_at?: string
        }
        Update: {
          allow_evaluation?: boolean
          allow_funded_sim?: boolean
          allow_payouts?: boolean
          country_code?: string
          created_at?: string
          disclosure_version?: string
          id?: string
          is_allowed?: boolean
          reason?: string | null
          require_kyc_before_payout?: boolean
          require_kyc_before_trading?: boolean
          require_market_data_attestation?: boolean
          terms_version?: string
          updated_at?: string
        }
        Relationships: []
      }
      liability_alerts: {
        Row: {
          alert_type: string
          assumed_avg_first_payout: number
          cash_reserve: number
          channels: Json
          cooldown_minutes: number
          created_at: string
          id: string
          is_active: boolean
          last_state: string
          last_triggered_at: string | null
          recipients: Json
          threshold: number
          updated_at: string
        }
        Insert: {
          alert_type?: string
          assumed_avg_first_payout?: number
          cash_reserve?: number
          channels?: Json
          cooldown_minutes?: number
          created_at?: string
          id?: string
          is_active?: boolean
          last_state?: string
          last_triggered_at?: string | null
          recipients?: Json
          threshold?: number
          updated_at?: string
        }
        Update: {
          alert_type?: string
          assumed_avg_first_payout?: number
          cash_reserve?: number
          channels?: Json
          cooldown_minutes?: number
          created_at?: string
          id?: string
          is_active?: boolean
          last_state?: string
          last_triggered_at?: string | null
          recipients?: Json
          threshold?: number
          updated_at?: string
        }
        Relationships: []
      }
      liability_buffer_settings: {
        Row: {
          assumed_avg_first_payout: number
          cash_reserve: number
          updated_at: string
          user_id: string
        }
        Insert: {
          assumed_avg_first_payout?: number
          cash_reserve?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          assumed_avg_first_payout?: number
          cash_reserve?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      ops_heartbeat_config: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      pass_rate_monitors: {
        Row: {
          created_at: string
          id: string
          pass_rate: number
          passed_accounts: number
          total_accounts: number
          triggered_action: string | null
          window_end: string
          window_start: string
        }
        Insert: {
          created_at?: string
          id?: string
          pass_rate?: number
          passed_accounts?: number
          total_accounts?: number
          triggered_action?: string | null
          window_end: string
          window_start: string
        }
        Update: {
          created_at?: string
          id?: string
          pass_rate?: number
          passed_accounts?: number
          total_accounts?: number
          triggered_action?: string | null
          window_end?: string
          window_start?: string
        }
        Relationships: []
      }
      payment_rails: {
        Row: {
          allowed_countries: string[]
          allowed_risk_tiers: number[]
          blocked_countries: string[]
          config: Json
          created_at: string
          currencies: string[]
          id: string
          is_enabled: boolean
          max_single_inbound: number | null
          max_single_outbound: number | null
          methods: string[]
          mode: string
          priority: number
          provider: string
          rail_key: string
          reason_disabled: string | null
          supports_inbound: boolean
          supports_outbound: boolean
          updated_at: string
        }
        Insert: {
          allowed_countries?: string[]
          allowed_risk_tiers?: number[]
          blocked_countries?: string[]
          config?: Json
          created_at?: string
          currencies?: string[]
          id?: string
          is_enabled?: boolean
          max_single_inbound?: number | null
          max_single_outbound?: number | null
          methods?: string[]
          mode?: string
          priority?: number
          provider: string
          rail_key: string
          reason_disabled?: string | null
          supports_inbound?: boolean
          supports_outbound?: boolean
          updated_at?: string
        }
        Update: {
          allowed_countries?: string[]
          allowed_risk_tiers?: number[]
          blocked_countries?: string[]
          config?: Json
          created_at?: string
          currencies?: string[]
          id?: string
          is_enabled?: boolean
          max_single_inbound?: number | null
          max_single_outbound?: number | null
          methods?: string[]
          mode?: string
          priority?: number
          provider?: string
          rail_key?: string
          reason_disabled?: string | null
          supports_inbound?: boolean
          supports_outbound?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      payment_system_state: {
        Row: {
          id: string
          is_paused_inbound: boolean
          is_paused_outbound: boolean
          pause_reason: string | null
          paused_at: string | null
          paused_by: string | null
          updated_at: string
        }
        Insert: {
          id?: string
          is_paused_inbound?: boolean
          is_paused_outbound?: boolean
          pause_reason?: string | null
          paused_at?: string | null
          paused_by?: string | null
          updated_at?: string
        }
        Update: {
          id?: string
          is_paused_inbound?: boolean
          is_paused_outbound?: boolean
          pause_reason?: string | null
          paused_at?: string | null
          paused_by?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      payment_transactions: {
        Row: {
          amount: number
          created_at: string
          currency: string
          direction: string
          id: string
          idempotency_key: string
          metadata: Json
          provider: string
          provider_payment_id: string | null
          purpose: string
          rail_key: string | null
          status: string
          updated_at: string
          user_country: string | null
          user_id: string
          user_risk_tier: number
        }
        Insert: {
          amount: number
          created_at?: string
          currency?: string
          direction: string
          id?: string
          idempotency_key: string
          metadata?: Json
          provider: string
          provider_payment_id?: string | null
          purpose: string
          rail_key?: string | null
          status?: string
          updated_at?: string
          user_country?: string | null
          user_id: string
          user_risk_tier?: number
        }
        Update: {
          amount?: number
          created_at?: string
          currency?: string
          direction?: string
          id?: string
          idempotency_key?: string
          metadata?: Json
          provider?: string
          provider_payment_id?: string | null
          purpose?: string
          rail_key?: string | null
          status?: string
          updated_at?: string
          user_country?: string | null
          user_id?: string
          user_risk_tier?: number
        }
        Relationships: [
          {
            foreignKeyName: "payment_transactions_rail_key_fkey"
            columns: ["rail_key"]
            isOneToOne: false
            referencedRelation: "payment_rails"
            referencedColumns: ["rail_key"]
          },
        ]
      }
      payout_methods: {
        Row: {
          block_reason: string | null
          cluster_id: string | null
          created_at: string
          id: string
          is_blocked: boolean
          is_verified: boolean
          method_details: Json
          method_hash: string
          method_type: string
          updated_at: string
          user_id: string
        }
        Insert: {
          block_reason?: string | null
          cluster_id?: string | null
          created_at?: string
          id?: string
          is_blocked?: boolean
          is_verified?: boolean
          method_details?: Json
          method_hash: string
          method_type: string
          updated_at?: string
          user_id: string
        }
        Update: {
          block_reason?: string | null
          cluster_id?: string | null
          created_at?: string
          id?: string
          is_blocked?: boolean
          is_verified?: boolean
          method_details?: Json
          method_hash?: string
          method_type?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payout_methods_cluster_id_fkey"
            columns: ["cluster_id"]
            isOneToOne: false
            referencedRelation: "identity_clusters"
            referencedColumns: ["id"]
          },
        ]
      }
      payout_payments: {
        Row: {
          amount: number
          confirmed_at: string | null
          created_at: string
          currency: string
          failed_at: string | null
          failure_code: string | null
          failure_reason: string | null
          id: string
          initiated_at: string
          initiated_by: string
          payout_id: string
          provider: string
          provider_event_id: string | null
          provider_payment_id: string | null
          raw_webhook: Json | null
          status: string
          updated_at: string
        }
        Insert: {
          amount: number
          confirmed_at?: string | null
          created_at?: string
          currency?: string
          failed_at?: string | null
          failure_code?: string | null
          failure_reason?: string | null
          id?: string
          initiated_at?: string
          initiated_by: string
          payout_id: string
          provider: string
          provider_event_id?: string | null
          provider_payment_id?: string | null
          raw_webhook?: Json | null
          status?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          confirmed_at?: string | null
          created_at?: string
          currency?: string
          failed_at?: string | null
          failure_code?: string | null
          failure_reason?: string | null
          id?: string
          initiated_at?: string
          initiated_by?: string
          payout_id?: string
          provider?: string
          provider_event_id?: string | null
          provider_payment_id?: string | null
          raw_webhook?: Json | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payout_payments_payout_id_fkey"
            columns: ["payout_id"]
            isOneToOne: false
            referencedRelation: "payouts"
            referencedColumns: ["id"]
          },
        ]
      }
      payouts: {
        Row: {
          account_id: string
          amount: number
          approved_at: string | null
          approved_by: string | null
          calculated_eligible_amount: number | null
          destination_name_match: boolean | null
          device_fingerprint_id: string | null
          fraud_review_id: string | null
          id: string
          kyc_name_verified: boolean
          paid_at: string | null
          paid_by: string | null
          payment_reference: string | null
          payout_method_id: string | null
          request_id: string | null
          requested_at: string
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          routing_decision: Json | null
          selected_rail_key: string | null
          status: Database["public"]["Enums"]["payout_status"]
          submitted_amount: number | null
          updated_at: string | null
        }
        Insert: {
          account_id: string
          amount: number
          approved_at?: string | null
          approved_by?: string | null
          calculated_eligible_amount?: number | null
          destination_name_match?: boolean | null
          device_fingerprint_id?: string | null
          fraud_review_id?: string | null
          id?: string
          kyc_name_verified?: boolean
          paid_at?: string | null
          paid_by?: string | null
          payment_reference?: string | null
          payout_method_id?: string | null
          request_id?: string | null
          requested_at?: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          routing_decision?: Json | null
          selected_rail_key?: string | null
          status?: Database["public"]["Enums"]["payout_status"]
          submitted_amount?: number | null
          updated_at?: string | null
        }
        Update: {
          account_id?: string
          amount?: number
          approved_at?: string | null
          approved_by?: string | null
          calculated_eligible_amount?: number | null
          destination_name_match?: boolean | null
          device_fingerprint_id?: string | null
          fraud_review_id?: string | null
          id?: string
          kyc_name_verified?: boolean
          paid_at?: string | null
          paid_by?: string | null
          payment_reference?: string | null
          payout_method_id?: string | null
          request_id?: string | null
          requested_at?: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          routing_decision?: Json | null
          selected_rail_key?: string | null
          status?: Database["public"]["Enums"]["payout_status"]
          submitted_amount?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payouts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payouts_device_fingerprint_id_fkey"
            columns: ["device_fingerprint_id"]
            isOneToOne: false
            referencedRelation: "device_fingerprints"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payouts_fraud_review_id_fkey"
            columns: ["fraud_review_id"]
            isOneToOne: false
            referencedRelation: "fraud_reviews"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payouts_payout_method_id_fkey"
            columns: ["payout_method_id"]
            isOneToOne: false
            referencedRelation: "payout_methods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payouts_selected_rail_key_fkey"
            columns: ["selected_rail_key"]
            isOneToOne: false
            referencedRelation: "payment_rails"
            referencedColumns: ["rail_key"]
          },
        ]
      }
      platform_accounts: {
        Row: {
          account_id: string
          created_at: string
          id: string
          platform_account_id: string
          platform_name: string
        }
        Insert: {
          account_id: string
          created_at?: string
          id?: string
          platform_account_id: string
          platform_name?: string
        }
        Update: {
          account_id?: string
          created_at?: string
          id?: string
          platform_account_id?: string
          platform_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_accounts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          card_payments_blocked: boolean
          chargeback_count_365d: number
          chargeback_count_90d: number
          chargeback_count_lifetime: number
          created_at: string
          email: string
          full_name: string | null
          id: string
          kyc_legal_name: string | null
          kyc_status: string | null
          kyc_verified_at: string | null
          last_chargeback_at: string | null
          lifetime_paid_total: number
          payouts_frozen: boolean
          payouts_frozen_at: string | null
          payouts_frozen_reason: string | null
          payouts_hold: boolean
          payouts_hold_at: string | null
          payouts_hold_reason: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          card_payments_blocked?: boolean
          chargeback_count_365d?: number
          chargeback_count_90d?: number
          chargeback_count_lifetime?: number
          created_at?: string
          email: string
          full_name?: string | null
          id?: string
          kyc_legal_name?: string | null
          kyc_status?: string | null
          kyc_verified_at?: string | null
          last_chargeback_at?: string | null
          lifetime_paid_total?: number
          payouts_frozen?: boolean
          payouts_frozen_at?: string | null
          payouts_frozen_reason?: string | null
          payouts_hold?: boolean
          payouts_hold_at?: string | null
          payouts_hold_reason?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          card_payments_blocked?: boolean
          chargeback_count_365d?: number
          chargeback_count_90d?: number
          chargeback_count_lifetime?: number
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          kyc_legal_name?: string | null
          kyc_status?: string | null
          kyc_verified_at?: string | null
          last_chargeback_at?: string | null
          lifetime_paid_total?: number
          payouts_frozen?: boolean
          payouts_frozen_at?: string | null
          payouts_frozen_reason?: string | null
          payouts_hold?: boolean
          payouts_hold_at?: string | null
          payouts_hold_reason?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      provider_api_calls: {
        Row: {
          account_id: string | null
          action: string
          created_at: string
          error: string | null
          external_account_id: string | null
          http_status: number | null
          id: string
          latency_ms: number | null
          provider: string
          request_payload: Json | null
          response_payload: Json | null
          success: boolean
        }
        Insert: {
          account_id?: string | null
          action: string
          created_at?: string
          error?: string | null
          external_account_id?: string | null
          http_status?: number | null
          id?: string
          latency_ms?: number | null
          provider: string
          request_payload?: Json | null
          response_payload?: Json | null
          success?: boolean
        }
        Update: {
          account_id?: string | null
          action?: string
          created_at?: string
          error?: string | null
          external_account_id?: string | null
          http_status?: number | null
          id?: string
          latency_ms?: number | null
          provider?: string
          request_payload?: Json | null
          response_payload?: Json | null
          success?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "provider_api_calls_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_webhook_events: {
        Row: {
          created_at: string
          error: string | null
          event_id: string | null
          event_type: string
          external_account_id: string | null
          headers_subset: Json
          id: string
          processed_at: string | null
          provider: string
          raw_body: string
          raw_hash: string
          received_at: string
          status: string
        }
        Insert: {
          created_at?: string
          error?: string | null
          event_id?: string | null
          event_type?: string
          external_account_id?: string | null
          headers_subset?: Json
          id?: string
          processed_at?: string | null
          provider: string
          raw_body: string
          raw_hash: string
          received_at?: string
          status?: string
        }
        Update: {
          created_at?: string
          error?: string | null
          event_id?: string | null
          event_type?: string
          external_account_id?: string | null
          headers_subset?: Json
          id?: string
          processed_at?: string | null
          provider?: string
          raw_body?: string
          raw_hash?: string
          received_at?: string
          status?: string
        }
        Relationships: []
      }
      reconciliation_runs: {
        Row: {
          account_id: string
          created_at: string
          created_by: string | null
          extra_in_db: Json
          from_ts: string
          id: string
          integrity_hash: string
          invalid_external: Json
          mismatched: Json
          missing_in_db: Json
          platform_account_id: string
          request_id: string
          summary: Json
          timestamp_deltas: Json
          to_ts: string
        }
        Insert: {
          account_id: string
          created_at?: string
          created_by?: string | null
          extra_in_db?: Json
          from_ts: string
          id?: string
          integrity_hash: string
          invalid_external?: Json
          mismatched?: Json
          missing_in_db?: Json
          platform_account_id: string
          request_id: string
          summary: Json
          timestamp_deltas?: Json
          to_ts: string
        }
        Update: {
          account_id?: string
          created_at?: string
          created_by?: string | null
          extra_in_db?: Json
          from_ts?: string
          id?: string
          integrity_hash?: string
          invalid_external?: Json
          mismatched?: Json
          missing_in_db?: Json
          platform_account_id?: string
          request_id?: string
          summary?: Json
          timestamp_deltas?: Json
          to_ts?: string
        }
        Relationships: [
          {
            foreignKeyName: "reconciliation_runs_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      risk_scores: {
        Row: {
          abuse_factors: Json | null
          abuse_score: number
          account_id: string
          calculated_at: string
          edge_factors: Json | null
          edge_score: number
          id: string
          payment_factors: Json | null
          payment_risk_score: number
          updated_at: string
        }
        Insert: {
          abuse_factors?: Json | null
          abuse_score?: number
          account_id: string
          calculated_at?: string
          edge_factors?: Json | null
          edge_score?: number
          id?: string
          payment_factors?: Json | null
          payment_risk_score?: number
          updated_at?: string
        }
        Update: {
          abuse_factors?: Json | null
          abuse_score?: number
          account_id?: string
          calculated_at?: string
          edge_factors?: Json | null
          edge_score?: number
          id?: string
          payment_factors?: Json | null
          payment_risk_score?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "risk_scores_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      risk_snapshots: {
        Row: {
          alarms: Json
          annual_loss_probability: number | null
          cohort_config_hash: string | null
          created_at: string
          id: string
          metadata: Json
          net_buffer: number | null
          pass_rate: number | null
          pass_rate_alert_level: string | null
          passed_accounts_in_window: number | null
          pending_payouts_amount: number | null
          pending_payouts_count: number | null
          reserve_breach_probability: number | null
          simulation_age_hours: number | null
          simulation_run_id: string | null
          simulation_stale: boolean | null
          snapshot_type: string
          total_accounts_in_window: number | null
          worst_month: number | null
        }
        Insert: {
          alarms?: Json
          annual_loss_probability?: number | null
          cohort_config_hash?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          net_buffer?: number | null
          pass_rate?: number | null
          pass_rate_alert_level?: string | null
          passed_accounts_in_window?: number | null
          pending_payouts_amount?: number | null
          pending_payouts_count?: number | null
          reserve_breach_probability?: number | null
          simulation_age_hours?: number | null
          simulation_run_id?: string | null
          simulation_stale?: boolean | null
          snapshot_type?: string
          total_accounts_in_window?: number | null
          worst_month?: number | null
        }
        Update: {
          alarms?: Json
          annual_loss_probability?: number | null
          cohort_config_hash?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          net_buffer?: number | null
          pass_rate?: number | null
          pass_rate_alert_level?: string | null
          passed_accounts_in_window?: number | null
          pending_payouts_amount?: number | null
          pending_payouts_count?: number | null
          reserve_breach_probability?: number | null
          simulation_age_hours?: number | null
          simulation_run_id?: string | null
          simulation_stale?: boolean | null
          snapshot_type?: string
          total_accounts_in_window?: number | null
          worst_month?: number | null
        }
        Relationships: []
      }
      risk_throttle_state: {
        Row: {
          auto_updated_at: string | null
          created_at: string
          eligibility_delay_bonus_days: number
          id: string
          manual_override_at: string | null
          manual_override_by: string | null
          manual_override_reason: string | null
          metrics_snapshot: Json
          pass_rate_14d: number
          pass_rate_30d: number
          pass_rate_7d: number
          purchase_enabled: boolean
          reason: string | null
          state: string
          updated_at: string
        }
        Insert: {
          auto_updated_at?: string | null
          created_at?: string
          eligibility_delay_bonus_days?: number
          id?: string
          manual_override_at?: string | null
          manual_override_by?: string | null
          manual_override_reason?: string | null
          metrics_snapshot?: Json
          pass_rate_14d?: number
          pass_rate_30d?: number
          pass_rate_7d?: number
          purchase_enabled?: boolean
          reason?: string | null
          state?: string
          updated_at?: string
        }
        Update: {
          auto_updated_at?: string | null
          created_at?: string
          eligibility_delay_bonus_days?: number
          id?: string
          manual_override_at?: string | null
          manual_override_by?: string | null
          manual_override_reason?: string | null
          metrics_snapshot?: Json
          pass_rate_14d?: number
          pass_rate_30d?: number
          pass_rate_7d?: number
          purchase_enabled?: boolean
          reason?: string | null
          state?: string
          updated_at?: string
        }
        Relationships: []
      }
      safety_setting_changes: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          created_at: string
          current_value_snapshot: Json | null
          id: string
          proposed_at: string
          proposed_by: string | null
          proposed_by_system: boolean
          proposed_value: Json
          reason: string | null
          rejected_at: string | null
          rejected_by: string | null
          setting_key: string
          status: string
          ticket_ref: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          current_value_snapshot?: Json | null
          id?: string
          proposed_at?: string
          proposed_by?: string | null
          proposed_by_system?: boolean
          proposed_value: Json
          reason?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          setting_key: string
          status?: string
          ticket_ref?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          current_value_snapshot?: Json | null
          id?: string
          proposed_at?: string
          proposed_by?: string | null
          proposed_by_system?: boolean
          proposed_value?: Json
          reason?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          setting_key?: string
          status?: string
          ticket_ref?: string | null
        }
        Relationships: []
      }
      simulation_runs: {
        Row: {
          assumptions: Json
          best_month: number
          cohort_configs: Json
          consecutive_loss_months: number
          created_at: string
          duration_ms: number | null
          full_results: Json
          id: string
          iterations: number
          max_drawdown: number
          months_per_iteration: number
          probability_of_loss: number
          profit_mean: number
          profit_p5: number
          profit_p50: number
          profit_p95: number
          profit_std_dev: number
          reserve_breach_probability: number | null
          reserve_threshold: number | null
          seed: number
          status: string
          triggered_by: string | null
          worst_month: number
        }
        Insert: {
          assumptions: Json
          best_month: number
          cohort_configs?: Json
          consecutive_loss_months?: number
          created_at?: string
          duration_ms?: number | null
          full_results: Json
          id?: string
          iterations?: number
          max_drawdown: number
          months_per_iteration?: number
          probability_of_loss: number
          profit_mean: number
          profit_p5: number
          profit_p50: number
          profit_p95: number
          profit_std_dev: number
          reserve_breach_probability?: number | null
          reserve_threshold?: number | null
          seed?: number
          status?: string
          triggered_by?: string | null
          worst_month: number
        }
        Update: {
          assumptions?: Json
          best_month?: number
          cohort_configs?: Json
          consecutive_loss_months?: number
          created_at?: string
          duration_ms?: number | null
          full_results?: Json
          id?: string
          iterations?: number
          max_drawdown?: number
          months_per_iteration?: number
          probability_of_loss?: number
          profit_mean?: number
          profit_p5?: number
          profit_p50?: number
          profit_p95?: number
          profit_std_dev?: number
          reserve_breach_probability?: number | null
          reserve_threshold?: number | null
          seed?: number
          status?: string
          triggered_by?: string | null
          worst_month?: number
        }
        Relationships: []
      }
      staff_notifications: {
        Row: {
          body: string | null
          created_at: string
          data: Json | null
          id: string
          idempotency_key: string | null
          is_read: boolean
          notification_type: string
          title: string
          user_id: string | null
        }
        Insert: {
          body?: string | null
          created_at?: string
          data?: Json | null
          id?: string
          idempotency_key?: string | null
          is_read?: boolean
          notification_type: string
          title: string
          user_id?: string | null
        }
        Update: {
          body?: string | null
          created_at?: string
          data?: Json | null
          id?: string
          idempotency_key?: string | null
          is_read?: boolean
          notification_type?: string
          title?: string
          user_id?: string | null
        }
        Relationships: []
      }
      support_email_actions: {
        Row: {
          action_type: string
          actor_user_id: string | null
          created_at: string
          email_id: string
          id: string
          metadata: Json
        }
        Insert: {
          action_type: string
          actor_user_id?: string | null
          created_at?: string
          email_id: string
          id?: string
          metadata?: Json
        }
        Update: {
          action_type?: string
          actor_user_id?: string | null
          created_at?: string
          email_id?: string
          id?: string
          metadata?: Json
        }
        Relationships: [
          {
            foreignKeyName: "support_email_actions_email_id_fkey"
            columns: ["email_id"]
            isOneToOne: false
            referencedRelation: "support_emails"
            referencedColumns: ["id"]
          },
        ]
      }
      support_emails: {
        Row: {
          ai_attempted_at: string | null
          ai_error: string | null
          ai_latency_ms: number | null
          ai_model: string | null
          ai_status: string
          ai_summary: string | null
          ai_tokens_used: number | null
          assigned_at: string | null
          assigned_to: string | null
          auto_send_blocked_reason: string | null
          auto_send_eligible_at: string | null
          auto_send_ready: boolean
          auto_sendable: boolean
          body_html: string | null
          body_text: string
          confidence: number
          context_hash: string | null
          created_at: string
          draft_approved: boolean
          draft_reply: string | null
          error: string | null
          facts_used: Json | null
          from_address: string
          human_override: boolean
          id: string
          inbound_message_id: string | null
          matched_account_id: string | null
          matched_user_id: string | null
          needs_human: boolean | null
          original_draft_reply: string | null
          original_tag: string | null
          overridden_at: string | null
          overridden_by: string | null
          override_reason: string | null
          prompt_version: string | null
          resend_inbound_id: string | null
          resend_message_id: string | null
          safety_notes: string | null
          sent_at: string | null
          sent_by: string | null
          status: string
          subject: string
          tag: string
          to_address: string | null
          updated_at: string
        }
        Insert: {
          ai_attempted_at?: string | null
          ai_error?: string | null
          ai_latency_ms?: number | null
          ai_model?: string | null
          ai_status?: string
          ai_summary?: string | null
          ai_tokens_used?: number | null
          assigned_at?: string | null
          assigned_to?: string | null
          auto_send_blocked_reason?: string | null
          auto_send_eligible_at?: string | null
          auto_send_ready?: boolean
          auto_sendable?: boolean
          body_html?: string | null
          body_text?: string
          confidence?: number
          context_hash?: string | null
          created_at?: string
          draft_approved?: boolean
          draft_reply?: string | null
          error?: string | null
          facts_used?: Json | null
          from_address: string
          human_override?: boolean
          id?: string
          inbound_message_id?: string | null
          matched_account_id?: string | null
          matched_user_id?: string | null
          needs_human?: boolean | null
          original_draft_reply?: string | null
          original_tag?: string | null
          overridden_at?: string | null
          overridden_by?: string | null
          override_reason?: string | null
          prompt_version?: string | null
          resend_inbound_id?: string | null
          resend_message_id?: string | null
          safety_notes?: string | null
          sent_at?: string | null
          sent_by?: string | null
          status?: string
          subject?: string
          tag?: string
          to_address?: string | null
          updated_at?: string
        }
        Update: {
          ai_attempted_at?: string | null
          ai_error?: string | null
          ai_latency_ms?: number | null
          ai_model?: string | null
          ai_status?: string
          ai_summary?: string | null
          ai_tokens_used?: number | null
          assigned_at?: string | null
          assigned_to?: string | null
          auto_send_blocked_reason?: string | null
          auto_send_eligible_at?: string | null
          auto_send_ready?: boolean
          auto_sendable?: boolean
          body_html?: string | null
          body_text?: string
          confidence?: number
          context_hash?: string | null
          created_at?: string
          draft_approved?: boolean
          draft_reply?: string | null
          error?: string | null
          facts_used?: Json | null
          from_address?: string
          human_override?: boolean
          id?: string
          inbound_message_id?: string | null
          matched_account_id?: string | null
          matched_user_id?: string | null
          needs_human?: boolean | null
          original_draft_reply?: string | null
          original_tag?: string | null
          overridden_at?: string | null
          overridden_by?: string | null
          override_reason?: string | null
          prompt_version?: string | null
          resend_inbound_id?: string | null
          resend_message_id?: string | null
          safety_notes?: string | null
          sent_at?: string | null
          sent_by?: string | null
          status?: string
          subject?: string
          tag?: string
          to_address?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      system_settings: {
        Row: {
          id: string
          key: string
          updated_at: string
          updated_by: string | null
          value: Json
        }
        Insert: {
          id?: string
          key: string
          updated_at?: string
          updated_by?: string | null
          value: Json
        }
        Update: {
          id?: string
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Relationships: []
      }
      trade_correlations: {
        Row: {
          account_id_a: string
          account_id_b: string
          correlation_score: number
          correlation_type: string
          detected_at: string
          id: string
          review_notes: string | null
          review_status: string
          reviewed_at: string | null
          reviewed_by: string | null
          sample_trades: Json
        }
        Insert: {
          account_id_a: string
          account_id_b: string
          correlation_score?: number
          correlation_type: string
          detected_at?: string
          id?: string
          review_notes?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          sample_trades?: Json
        }
        Update: {
          account_id_a?: string
          account_id_b?: string
          correlation_score?: number
          correlation_type?: string
          detected_at?: string
          id?: string
          review_notes?: string | null
          review_status?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          sample_trades?: Json
        }
        Relationships: [
          {
            foreignKeyName: "trade_correlations_account_id_a_fkey"
            columns: ["account_id_a"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trade_correlations_account_id_b_fkey"
            columns: ["account_id_b"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      trades: {
        Row: {
          account_id: string
          closed_at: string | null
          commission: number | null
          entry_price: number | null
          exit_price: number | null
          id: string
          opened_at: string
          platform_account_id: string | null
          platform_trade_id: string | null
          pnl: number | null
          quantity: number
          raw_payload: Json | null
          side: string
          status: string
          symbol: string
        }
        Insert: {
          account_id: string
          closed_at?: string | null
          commission?: number | null
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          opened_at?: string
          platform_account_id?: string | null
          platform_trade_id?: string | null
          pnl?: number | null
          quantity: number
          raw_payload?: Json | null
          side: string
          status?: string
          symbol: string
        }
        Update: {
          account_id?: string
          closed_at?: string | null
          commission?: number | null
          entry_price?: number | null
          exit_price?: number | null
          id?: string
          opened_at?: string
          platform_account_id?: string | null
          platform_trade_id?: string | null
          pnl?: number | null
          quantity?: number
          raw_payload?: Json | null
          side?: string
          status?: string
          symbol?: string
        }
        Relationships: [
          {
            foreignKeyName: "trades_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      user_cohort_payouts: {
        Row: {
          cohort_id: string
          created_at: string
          id: string
          lifetime_paid_total: number
          updated_at: string
          user_id: string
        }
        Insert: {
          cohort_id: string
          created_at?: string
          id?: string
          lifetime_paid_total?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          cohort_id?: string
          created_at?: string
          id?: string
          lifetime_paid_total?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_cohort_payouts_cohort_id_fkey"
            columns: ["cohort_id"]
            isOneToOne: false
            referencedRelation: "cohorts"
            referencedColumns: ["id"]
          },
        ]
      }
      user_jurisdiction: {
        Row: {
          confidence: number
          country_code: string
          notes: string | null
          resolution_method: string
          resolved_at: string
          user_id: string
        }
        Insert: {
          confidence?: number
          country_code: string
          notes?: string | null
          resolution_method: string
          resolved_at?: string
          user_id: string
        }
        Update: {
          confidence?: number
          country_code?: string
          notes?: string | null
          resolution_method?: string
          resolved_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          assigned_at: string
          assigned_by: string | null
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string | null
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      violations: {
        Row: {
          account_id: string
          actual_value: number | null
          breach_day: string | null
          confirmation_notes: string | null
          confirmed_at: string | null
          confirmed_by: string | null
          description: string
          detected_at: string
          id: string
          platform_trade_id: string | null
          rule_threshold: number | null
          rule_type: string
          trade_id: string | null
        }
        Insert: {
          account_id: string
          actual_value?: number | null
          breach_day?: string | null
          confirmation_notes?: string | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          description: string
          detected_at?: string
          id?: string
          platform_trade_id?: string | null
          rule_threshold?: number | null
          rule_type: string
          trade_id?: string | null
        }
        Update: {
          account_id?: string
          actual_value?: number | null
          breach_day?: string | null
          confirmation_notes?: string | null
          confirmed_at?: string | null
          confirmed_by?: string | null
          description?: string
          detected_at?: string
          id?: string
          platform_trade_id?: string | null
          rule_threshold?: number | null
          rule_type?: string
          trade_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "violations_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "violations_trade_id_fkey"
            columns: ["trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      account_last_event: {
        Row: {
          account_id: string | null
          last_event_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "account_events_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_daily_cost: {
        Row: {
          avg_latency_ms: number | null
          call_count: number | null
          day: string | null
          function_name: string | null
          model: string | null
          total_cost_cents: number | null
          total_tokens: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      apply_geo_mismatch_hold: { Args: { _user_id: string }; Returns: Json }
      approve_payout_atomic: {
        Args: {
          _approved_by: string
          _calculated_eligible_amount?: number
          _fraud_review_id?: string
          _payout_id: string
          _review_notes?: string
          _submitted_amount?: number
        }
        Returns: Json
      }
      approve_safety_setting_change: {
        Args: { _change_id: string; _reason?: string }
        Returns: Json
      }
      assert_jurisdiction_allowed: { Args: { p_action: string }; Returns: Json }
      assert_user_jurisdiction_allowed: {
        Args: { _user_id: string; p_action: string }
        Returns: Json
      }
      audit_row_canonical: {
        Args: {
          _account_id: string
          _action: string
          _created_at: string
          _details: Json
          _id: string
          _idempotency: string
          _ip: unknown
          _prev_hash: string
          _reason: string
          _request_id: string
          _ua: string
          _user_id: string
        }
        Returns: string
      }
      bootstrap_first_admin: { Args: { _user_id: string }; Returns: boolean }
      bump_fingerprint_seen: { Args: { _id: string }; Returns: undefined }
      bytea_to_text: { Args: { data: string }; Returns: string }
      calculate_payout_eligibility: {
        Args: { _account_id: string }
        Returns: Json
      }
      check_consistency_rules: { Args: { _account_id: string }; Returns: Json }
      check_cron_health: { Args: never; Returns: undefined }
      check_geo_mismatch: { Args: { _user_id: string }; Returns: Json }
      check_liability_alert: { Args: never; Returns: Json }
      check_payment_system_paused: {
        Args: { p_direction: string }
        Returns: Json
      }
      check_payout_method_duplicate: {
        Args: { _method_hash: string; _user_id: string }
        Returns: Json
      }
      claim_checkout_fulfillment: {
        Args: { p_session_id: string }
        Returns: {
          fulfilled_account_id: string
          id: string
          status: string
          tier_id: string
          user_id: string
        }[]
      }
      claim_checkout_fulfillment_v2: {
        Args: { p_provider: string; p_provider_session_id: string }
        Returns: {
          fulfilled_account_id: string
          id: string
          status: string
          tier_id: string
          user_id: string
        }[]
      }
      cleanup_broker_payload_samples: { Args: never; Returns: undefined }
      cleanup_old_payload_samples: { Args: never; Returns: undefined }
      confirm_payout_payment: {
        Args: {
          _confirmed_at?: string
          _payout_id: string
          _provider: string
          _provider_event_id: string
          _provider_payment_id: string
          _raw_webhook?: Json
        }
        Returns: Json
      }
      create_risk_snapshot: {
        Args: {
          _alarms?: Json
          _annual_loss_prob?: number
          _cohort_config_hash?: string
          _metadata?: Json
          _net_buffer?: number
          _pass_rate?: number
          _pass_rate_alert_level?: string
          _passed_accounts?: number
          _pending_payouts_amount?: number
          _pending_payouts_count?: number
          _reserve_breach_prob?: number
          _simulation_age_hours?: number
          _simulation_run_id?: string
          _simulation_stale?: boolean
          _total_accounts?: number
          _worst_month?: number
        }
        Returns: string
      }
      detect_cross_instrument_correlations: {
        Args: {
          _account_id: string
          _min_match_count?: number
          _time_window_seconds?: number
        }
        Returns: Json
      }
      detect_trade_correlations:
        | {
            Args: {
              _account_id: string
              _min_correlation_score?: number
              _time_window_seconds?: number
            }
            Returns: Json
          }
        | {
            Args: {
              _account_id: string
              _min_match_count?: number
              _time_window_seconds?: number
            }
            Returns: Json
          }
        | {
            Args: {
              _account_id: string
              _lookback_days?: number
              _min_match_count?: number
              _time_window_seconds?: number
            }
            Returns: Json
          }
      emit_cron_health_heartbeat: { Args: never; Returns: undefined }
      evaluate_econ_breaker: { Args: never; Returns: undefined }
      fail_payout_payment: {
        Args: {
          _failure_code?: string
          _failure_reason?: string
          _payout_id: string
          _provider: string
          _provider_event_id: string
          _provider_payment_id: string
          _raw_webhook?: Json
        }
        Returns: Json
      }
      fulfill_checkout_session:
        | {
            Args: {
              p_account_number: string
              p_account_size: number
              p_amount_cents: number
              p_cohort_id: string
              p_currency: string
              p_disclaimer_version?: string
              p_payment_intent: string
              p_product_description?: string
              p_queue_id: string
              p_rule_snapshot: Json
              p_stripe_session_id: string
              p_tier_id: string
              p_user_id: string
            }
            Returns: string
          }
        | {
            Args: {
              p_account_number: string
              p_account_size: number
              p_amount_cents: number
              p_cohort_name: string
              p_currency: string
              p_disclaimer_version?: string
              p_payment_intent: string
              p_product_description?: string
              p_queue_id: string
              p_stripe_session_id: string
              p_tier_id: string
              p_user_id: string
            }
            Returns: string
          }
      fulfill_checkout_session_v2: {
        Args: {
          p_account_number: string
          p_account_size: number
          p_amount_cents: number
          p_cohort_name: string
          p_currency: string
          p_disclaimer_version?: string
          p_product_description?: string
          p_provider: string
          p_provider_payment_id: string
          p_provider_session_id: string
          p_queue_id: string
          p_tier_id: string
          p_user_id: string
        }
        Returns: string
      }
      get_ai_daily_token_sum: {
        Args: { p_date?: string; p_function_name: string }
        Returns: number
      }
      get_cohort_account_stats: {
        Args: never
        Returns: {
          cohort_id: string
          passed_accounts: number
          passed_no_paid_payout: number
          total_accounts: number
        }[]
      }
      get_dispute_rate_snapshot: {
        Args: { window_days?: number }
        Returns: Json
      }
      get_econ_breaker_state: {
        Args: never
        Returns: {
          approvals_blocked: boolean
          breaker_level: string
          evaluations_frozen: boolean
          last_evaluated_at: string
          net_buffer: number
          payouts_blocked: boolean
          pending_liability: number
          previous_level: string
          rolling_pass_count: number
          rolling_pass_rate: number
          rolling_total_count: number
          triggered_by: string
        }[]
      }
      get_econ_guardrail_status: {
        Args: { _window_days?: number }
        Returns: Json
      }
      get_liability_buffer_settings: { Args: never; Returns: Json }
      get_liability_snapshot: {
        Args: {
          _assumed_avg_first_payout?: number
          _cash_reserve?: number
          _days_forward?: number
        }
        Returns: Json
      }
      get_pending_pass_velocity: {
        Args: { _window_hours?: number }
        Returns: Json
      }
      get_rolling_pass_rate: { Args: { _window_days?: number }; Returns: Json }
      get_support_ops_metrics: { Args: { p_days?: number }; Returns: Json }
      get_user_roles: {
        Args: { _user_id: string }
        Returns: Database["public"]["Enums"]["app_role"][]
      }
      has_any_role: {
        Args: {
          _roles: Database["public"]["Enums"]["app_role"][]
          _user_id: string
        }
        Returns: boolean
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      http: {
        Args: { request: Database["public"]["CompositeTypes"]["http_request"] }
        Returns: Database["public"]["CompositeTypes"]["http_response"]
        SetofOptions: {
          from: "http_request"
          to: "http_response"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      http_delete:
        | {
            Args: { uri: string }
            Returns: Database["public"]["CompositeTypes"]["http_response"]
            SetofOptions: {
              from: "*"
              to: "http_response"
              isOneToOne: true
              isSetofReturn: false
            }
          }
        | {
            Args: { content: string; content_type: string; uri: string }
            Returns: Database["public"]["CompositeTypes"]["http_response"]
            SetofOptions: {
              from: "*"
              to: "http_response"
              isOneToOne: true
              isSetofReturn: false
            }
          }
      http_get:
        | {
            Args: { uri: string }
            Returns: Database["public"]["CompositeTypes"]["http_response"]
            SetofOptions: {
              from: "*"
              to: "http_response"
              isOneToOne: true
              isSetofReturn: false
            }
          }
        | {
            Args: { data: Json; uri: string }
            Returns: Database["public"]["CompositeTypes"]["http_response"]
            SetofOptions: {
              from: "*"
              to: "http_response"
              isOneToOne: true
              isSetofReturn: false
            }
          }
      http_head: {
        Args: { uri: string }
        Returns: Database["public"]["CompositeTypes"]["http_response"]
        SetofOptions: {
          from: "*"
          to: "http_response"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      http_header: {
        Args: { field: string; value: string }
        Returns: Database["public"]["CompositeTypes"]["http_header"]
        SetofOptions: {
          from: "*"
          to: "http_header"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      http_list_curlopt: {
        Args: never
        Returns: {
          curlopt: string
          value: string
        }[]
      }
      http_patch: {
        Args: { content: string; content_type: string; uri: string }
        Returns: Database["public"]["CompositeTypes"]["http_response"]
        SetofOptions: {
          from: "*"
          to: "http_response"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      http_post:
        | {
            Args: { content: string; content_type: string; uri: string }
            Returns: Database["public"]["CompositeTypes"]["http_response"]
            SetofOptions: {
              from: "*"
              to: "http_response"
              isOneToOne: true
              isSetofReturn: false
            }
          }
        | {
            Args: { data: Json; uri: string }
            Returns: Database["public"]["CompositeTypes"]["http_response"]
            SetofOptions: {
              from: "*"
              to: "http_response"
              isOneToOne: true
              isSetofReturn: false
            }
          }
      http_put: {
        Args: { content: string; content_type: string; uri: string }
        Returns: Database["public"]["CompositeTypes"]["http_response"]
        SetofOptions: {
          from: "*"
          to: "http_response"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      http_reset_curlopt: { Args: never; Returns: boolean }
      http_set_curlopt: {
        Args: { curlopt: string; value: string }
        Returns: boolean
      }
      ingest_trade_atomic: {
        Args: {
          p_account_id: string
          p_commission: number
          p_entry_price: number
          p_net_pnl: number
          p_opened_at: string
          p_platform_account_id: string
          p_platform_trade_id: string
          p_quantity: number
          p_raw_payload: Json
          p_side: string
          p_symbol: string
          p_trading_day: string
        }
        Returns: Json
      }
      initiate_payout_payment: {
        Args: {
          _amount: number
          _currency?: string
          _initiated_by?: string
          _payout_id: string
          _provider: string
        }
        Returns: Json
      }
      manual_payout_hold_release: {
        Args: {
          _actor_user_id: string
          _evidence_notes?: string
          _reason: string
          _target_user_id: string
        }
        Returns: Json
      }
      manual_payout_unfreeze: {
        Args: {
          _evidence_notes?: string
          _reason: string
          _target_user_id: string
        }
        Returns: Json
      }
      manual_risk_throttle_override: {
        Args: {
          p_eligibility_delay_bonus_days: number
          p_purchase_enabled: boolean
          p_reason: string
        }
        Returns: undefined
      }
      mark_payout_paid: {
        Args: {
          _payment_reference: string
          _payout_id: string
          _reviewed_by: string
        }
        Returns: Json
      }
      normalize_legal_name: { Args: { input: string }; Returns: string }
      process_chargeback_event: {
        Args: {
          _amount: number
          _card_fingerprint?: string
          _country?: string
          _currency: string
          _ip?: unknown
          _occurred_at: string
          _provider: string
          _provider_dispute_id: string
          _provider_event_id: string
          _reason_code: string
          _stage: string
          _user_id: string
        }
        Returns: Json
      }
      propose_econ_auto_tightening: { Args: { _econ: Json }; Returns: Json }
      propose_safety_setting_change: {
        Args: {
          _proposed_value: Json
          _reason?: string
          _setting_key: string
          _ticket_ref?: string
        }
        Returns: Json
      }
      purge_cron_http_runs: {
        Args: { retain_days?: number }
        Returns: undefined
      }
      record_geo_signal: {
        Args: {
          _confidence?: number
          _country_code: string
          _metadata?: Json
          _signal_type: string
          _source?: string
          _user_id: string
        }
        Returns: Json
      }
      reject_payout_atomic: {
        Args: { _payout_id: string; _reason: string; _rejected_by: string }
        Returns: Json
      }
      reject_safety_setting_change: {
        Args: { _change_id: string; _reason?: string }
        Returns: Json
      }
      reset_payout_cycle: { Args: { _account_id: string }; Returns: undefined }
      resolve_user_jurisdiction: { Args: { _user_id: string }; Returns: Json }
      seed_submit_payout_request: {
        Args: {
          _account_id: string
          _requested_amount: number
          _seed_secret: string
          _user_id: string
        }
        Returns: Json
      }
      select_payment_rail:
        | {
            Args: {
              p_amount: number
              p_country: string
              p_currency?: string
              p_direction: string
              p_method: string
              p_risk_tier: number
            }
            Returns: {
              priority: number
              provider: string
              rail_key: string
              reason: string
            }[]
          }
        | {
            Args: {
              p_amount: number
              p_country: string
              p_currency?: string
              p_direction: string
              p_method: string
              p_risk_tier: number
            }
            Returns: {
              priority: number
              provider: string
              rail_key: string
              reason: string
            }[]
          }
      simulate_compound_config_impact: { Args: never; Returns: Json }
      spawn_next_phase_account: {
        Args: { _from_account_id: string; _request_id?: string }
        Returns: Json
      }
      submit_payout_request: {
        Args: { _account_id: string; _requested_amount: number }
        Returns: Json
      }
      text_to_bytea: { Args: { data: string }; Returns: string }
      toggle_payment_system: {
        Args: {
          _actor_user_id: string
          _direction: string
          _pause: boolean
          _reason: string
        }
        Returns: Json
      }
      trading_day_et: {
        Args: { reset_hour?: number; ts: string }
        Returns: string
      }
      try_auto_pass: {
        Args: { _account_id: string; _request_id: string }
        Returns: Json
      }
      update_risk_throttle: {
        Args: {
          p_eligibility_delay_bonus_days: number
          p_metrics_snapshot: Json
          p_pass_rate_14d: number
          p_pass_rate_30d: number
          p_pass_rate_7d: number
          p_purchase_enabled: boolean
          p_reason: string
          p_state: string
        }
        Returns: undefined
      }
      upsert_daily_stat: {
        Args: {
          _account_id: string
          _commission: number
          _pnl: number
          _trading_day: string
        }
        Returns: undefined
      }
      upsert_liability_buffer_settings: {
        Args: { _assumed_avg_first_payout: number; _cash_reserve: number }
        Returns: Json
      }
      urlencode:
        | { Args: { data: Json }; Returns: string }
        | {
            Args: { string: string }
            Returns: {
              error: true
            } & "Could not choose the best candidate function between: public.urlencode(string => bytea), public.urlencode(string => varchar). Try renaming the parameters or the function itself in the database so function overloading can be resolved"
          }
        | {
            Args: { string: string }
            Returns: {
              error: true
            } & "Could not choose the best candidate function between: public.urlencode(string => bytea), public.urlencode(string => varchar). Try renaming the parameters or the function itself in the database so function overloading can be resolved"
          }
      validate_payout_request: {
        Args: { _account_id: string; _requested_amount: number }
        Returns: Json
      }
      verify_audit_chain: {
        Args: { _from_date?: string; _to_date?: string }
        Returns: Json
      }
      verify_payout_name_match:
        | { Args: { _destination_name: string }; Returns: Json }
        | {
            Args: { _destination_name: string; _user_id: string }
            Returns: Json
          }
    }
    Enums: {
      account_event_type:
        | "account_created"
        | "trade_ingested"
        | "daily_reset"
        | "breach_detected"
        | "breach_confirmed"
        | "failure_confirmed"
        | "passed"
        | "payout_requested"
        | "payout_under_review"
        | "payout_approved"
        | "payout_rejected"
        | "payout_paid"
        | "status_changed"
      account_status:
        | "active"
        | "breached_detected"
        | "under_review"
        | "failed_confirmed"
        | "passed"
        | "payout_requested"
        | "payout_under_review"
        | "payout_approved"
        | "closed"
      app_role: "trader" | "risk_officer" | "support" | "admin"
      audit_action:
        | "account_created"
        | "status_changed"
        | "breach_detected"
        | "flag_created"
        | "flag_cleared"
        | "flag_escalated"
        | "payout_requested"
        | "payout_approved"
        | "payout_rejected"
        | "failure_confirmed"
        | "role_assigned"
        | "role_revoked"
        | "cohort_assigned"
        | "intake_paused"
        | "intake_resumed"
        | "rule_breach_detected"
        | "evidence_pack_exported"
        | "trade_reconciliation_run"
        | "cohort_updated"
        | "liability_alert_fired"
        | "payout_freeze_auto_chargeback"
        | "card_block_auto_chargeback"
        | "payout_freeze_manual"
        | "payout_unfreeze_manual"
        | "jurisdiction_resolved"
        | "jurisdiction_blocked"
        | "geo_mismatch_detected"
        | "payout_hold_release_manual"
        | "payment_system_paused"
        | "payment_system_resumed"
        | "payout_paid"
        | "ingest_blocked"
        | "ingest_quarantined"
        | "ingest_error"
        | "ingest_rejected"
      flag_status: "pending" | "cleared" | "escalated" | "resolved"
      payout_status:
        | "pending"
        | "under_review"
        | "approved"
        | "rejected"
        | "paid"
        | "payment_initiated"
        | "paid_confirmed"
        | "payment_failed"
    }
    CompositeTypes: {
      http_header: {
        field: string | null
        value: string | null
      }
      http_request: {
        method: unknown
        uri: string | null
        headers: Database["public"]["CompositeTypes"]["http_header"][] | null
        content_type: string | null
        content: string | null
      }
      http_response: {
        status: number | null
        content_type: string | null
        headers: Database["public"]["CompositeTypes"]["http_header"][] | null
        content: string | null
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      account_event_type: [
        "account_created",
        "trade_ingested",
        "daily_reset",
        "breach_detected",
        "breach_confirmed",
        "failure_confirmed",
        "passed",
        "payout_requested",
        "payout_under_review",
        "payout_approved",
        "payout_rejected",
        "payout_paid",
        "status_changed",
      ],
      account_status: [
        "active",
        "breached_detected",
        "under_review",
        "failed_confirmed",
        "passed",
        "payout_requested",
        "payout_under_review",
        "payout_approved",
        "closed",
      ],
      app_role: ["trader", "risk_officer", "support", "admin"],
      audit_action: [
        "account_created",
        "status_changed",
        "breach_detected",
        "flag_created",
        "flag_cleared",
        "flag_escalated",
        "payout_requested",
        "payout_approved",
        "payout_rejected",
        "failure_confirmed",
        "role_assigned",
        "role_revoked",
        "cohort_assigned",
        "intake_paused",
        "intake_resumed",
        "rule_breach_detected",
        "evidence_pack_exported",
        "trade_reconciliation_run",
        "cohort_updated",
        "liability_alert_fired",
        "payout_freeze_auto_chargeback",
        "card_block_auto_chargeback",
        "payout_freeze_manual",
        "payout_unfreeze_manual",
        "jurisdiction_resolved",
        "jurisdiction_blocked",
        "geo_mismatch_detected",
        "payout_hold_release_manual",
        "payment_system_paused",
        "payment_system_resumed",
        "payout_paid",
        "ingest_blocked",
        "ingest_quarantined",
        "ingest_error",
        "ingest_rejected",
      ],
      flag_status: ["pending", "cleared", "escalated", "resolved"],
      payout_status: [
        "pending",
        "under_review",
        "approved",
        "rejected",
        "paid",
        "payment_initiated",
        "paid_confirmed",
        "payment_failed",
      ],
    },
  },
} as const
