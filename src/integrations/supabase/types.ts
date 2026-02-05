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
      account_events: {
        Row: {
          account_id: string
          created_at: string
          event_data: Json
          event_type: Database["public"]["Enums"]["account_event_type"]
          id: string
          request_id: string | null
        }
        Insert: {
          account_id: string
          created_at?: string
          event_data?: Json
          event_type: Database["public"]["Enums"]["account_event_type"]
          id?: string
          request_id?: string | null
        }
        Update: {
          account_id?: string
          created_at?: string
          event_data?: Json
          event_type?: Database["public"]["Enums"]["account_event_type"]
          id?: string
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
      accounts: {
        Row: {
          account_number: string
          cohort_id: string
          created_at: string
          current_balance: number
          daily_pnl: number
          daily_pnl_start_balance: number | null
          daily_reset_at: string | null
          failed_at: string | null
          highest_balance: number
          id: string
          last_trade_at: string | null
          passed_at: string | null
          payout_cycle_start_balance: number | null
          payout_cycle_started_at: string | null
          rule_snapshot: Json | null
          starting_balance: number
          status: Database["public"]["Enums"]["account_status"]
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
          failed_at?: string | null
          highest_balance?: number
          id?: string
          last_trade_at?: string | null
          passed_at?: string | null
          payout_cycle_start_balance?: number | null
          payout_cycle_started_at?: string | null
          rule_snapshot?: Json | null
          starting_balance?: number
          status?: Database["public"]["Enums"]["account_status"]
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
          failed_at?: string | null
          highest_balance?: number
          id?: string
          last_trade_at?: string | null
          passed_at?: string | null
          payout_cycle_start_balance?: number | null
          payout_cycle_started_at?: string | null
          rule_snapshot?: Json | null
          starting_balance?: number
          status?: Database["public"]["Enums"]["account_status"]
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
        ]
      }
      audit_logs: {
        Row: {
          account_id: string | null
          action: Database["public"]["Enums"]["audit_action"]
          created_at: string
          details: Json
          id: string
          ip_address: string | null
          reason: string | null
          request_id: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          account_id?: string | null
          action: Database["public"]["Enums"]["audit_action"]
          created_at?: string
          details?: Json
          id?: string
          ip_address?: string | null
          reason?: string | null
          request_id?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          account_id?: string | null
          action?: Database["public"]["Enums"]["audit_action"]
          created_at?: string
          details?: Json
          id?: string
          ip_address?: string | null
          reason?: string | null
          request_id?: string | null
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
      cohorts: {
        Row: {
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
          max_payout_absolute: number | null
          max_payout_percent: number
          max_position_size_percent: number
          max_total_drawdown_percent: number
          min_trading_days: number
          min_trading_days_between_payouts: number
          name: string
          payout_cooldown_days: number
          payout_eligibility_delay_days: number
          payout_split_percent: number
          profit_target_percent: number
          version: number
        }
        Insert: {
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
          max_payout_absolute?: number | null
          max_payout_percent?: number
          max_position_size_percent?: number
          max_total_drawdown_percent?: number
          min_trading_days?: number
          min_trading_days_between_payouts?: number
          name: string
          payout_cooldown_days?: number
          payout_eligibility_delay_days?: number
          payout_split_percent?: number
          profit_target_percent?: number
          version?: number
        }
        Update: {
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
          max_payout_absolute?: number | null
          max_payout_percent?: number
          max_position_size_percent?: number
          max_total_drawdown_percent?: number
          min_trading_days?: number
          min_trading_days_between_payouts?: number
          name?: string
          payout_cooldown_days?: number
          payout_eligibility_delay_days?: number
          payout_split_percent?: number
          profit_target_percent?: number
          version?: number
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
      payouts: {
        Row: {
          account_id: string
          amount: number
          calculated_eligible_amount: number | null
          device_fingerprint_id: string | null
          fraud_review_id: string | null
          id: string
          paid_at: string | null
          payment_reference: string | null
          payout_method_id: string | null
          request_id: string | null
          requested_at: string
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["payout_status"]
          submitted_amount: number | null
          updated_at: string | null
        }
        Insert: {
          account_id: string
          amount: number
          calculated_eligible_amount?: number | null
          device_fingerprint_id?: string | null
          fraud_review_id?: string | null
          id?: string
          paid_at?: string | null
          payment_reference?: string | null
          payout_method_id?: string | null
          request_id?: string | null
          requested_at?: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["payout_status"]
          submitted_amount?: number | null
          updated_at?: string | null
        }
        Update: {
          account_id?: string
          amount?: number
          calculated_eligible_amount?: number | null
          device_fingerprint_id?: string | null
          fraud_review_id?: string | null
          id?: string
          paid_at?: string | null
          payment_reference?: string | null
          payout_method_id?: string | null
          request_id?: string | null
          requested_at?: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
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
          created_at: string
          email: string
          full_name: string | null
          id: string
          kyc_status: string | null
          kyc_verified_at: string | null
          lifetime_paid_total: number
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email: string
          full_name?: string | null
          id?: string
          kyc_status?: string | null
          kyc_verified_at?: string | null
          lifetime_paid_total?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          kyc_status?: string | null
          kyc_verified_at?: string | null
          lifetime_paid_total?: number
          updated_at?: string
          user_id?: string
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
          entry_price: number
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
          entry_price: number
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
          entry_price?: number
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
    }
    Functions: {
      bootstrap_first_admin: { Args: { _user_id: string }; Returns: boolean }
      bump_fingerprint_seen: { Args: { _id: string }; Returns: undefined }
      calculate_payout_eligibility: {
        Args: { _account_id: string }
        Returns: Json
      }
      check_payout_method_duplicate: {
        Args: { _method_hash: string; _user_id: string }
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
      get_cohort_account_stats: {
        Args: never
        Returns: {
          cohort_id: string
          passed_accounts: number
          passed_no_paid_payout: number
          total_accounts: number
        }[]
      }
      get_liability_snapshot: {
        Args: { _days_forward?: number }
        Returns: Json
      }
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
      mark_payout_paid: {
        Args: {
          _payment_reference: string
          _payout_id: string
          _reviewed_by: string
        }
        Returns: Json
      }
      reset_payout_cycle: { Args: { _account_id: string }; Returns: undefined }
      validate_payout_request: {
        Args: { _account_id: string; _requested_amount: number }
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
      flag_status: "pending" | "cleared" | "escalated" | "resolved"
      payout_status:
        | "pending"
        | "under_review"
        | "approved"
        | "rejected"
        | "paid"
    }
    CompositeTypes: {
      [_ in never]: never
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
      ],
      flag_status: ["pending", "cleared", "escalated", "resolved"],
      payout_status: [
        "pending",
        "under_review",
        "approved",
        "rejected",
        "paid",
      ],
    },
  },
} as const
