import { supabase } from '@/integrations/supabase/client';

/**
 * Lightweight conversion-tracking utility.
 *
 * - Generates a stable session_id in sessionStorage
 * - Captures UTM params once per session from the URL
 * - Caches user_id from auth state (no per-event session fetch)
 * - Fire-and-forget: never throws, never blocks UI
 * - Never logs PII (no emails, no payment refs)
 */

const SESSION_KEY = 'ra_sid';
const UTM_KEY = 'ra_utm';
const MAX_EVENT_LEN = 64;
const MAX_PROPS_LEN = 2000;

/** Exhaustive list of tracked events — prevents silent typo fragmentation. */
export type AnalyticsEvent =
  | 'lp_view'
  | 'lp_click_cta'
  | 'pricing_toggle'
  | 'checkout_view'
  | 'checkout_tier_select'
  | 'checkout_disclaimer_toggle'
  | 'checkout_click_pay'
  | 'checkout_rules_acknowledged'
  | 'checkout_session_created'
  | 'checkout_session_failed'
  | 'payouts_view'
  | 'payout_request_view'
  | 'payout_blocked'
  | 'payout_request_submitted'
  // Launch prep: demand signal for upcoming tiers
  | 'tier_upcoming_view'
  | 'tier_upcoming_click'
  | 'tier_live_flip'
  // Landing page engagement
  | 'promo_view'
  | 'promo_click'
  | 'promo_dismiss'
  | 'compare_view'
  | 'lp_click_rules'
  | 'rules_view'
  | 'testimonial_view'
  | 'platform_logos_view'
  | 'stats_counter_view'
  // Escape hatch for ad-hoc dev debugging (never use in prod paths)
  | `debug_${string}`;

/** Cached auth user id — set once on first call + auth state changes. */
let cachedUserId: string | null = null;
let authInitialized = false;

function initAuth(): void {
  if (authInitialized) return;
  authInitialized = true;

  // Read current session once
  supabase.auth.getSession().then(({ data }) => {
    cachedUserId = data?.session?.user?.id ?? null;
  }).catch(() => { /* ignore */ });

  // Keep it fresh on login/logout
  supabase.auth.onAuthStateChange((_event, session) => {
    cachedUserId = session?.user?.id ?? null;
  });
}

function getSessionId(): string {
  let sid = sessionStorage.getItem(SESSION_KEY);
  if (!sid) {
    sid = crypto.randomUUID();
    sessionStorage.setItem(SESSION_KEY, sid);
  }
  return sid;
}

interface UtmParams {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
}

function getUtm(): UtmParams {
  const cached = sessionStorage.getItem(UTM_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch { /* fall through */ }
  }

  const sp = new URLSearchParams(window.location.search);
  const utm: UtmParams = {
    utm_source: sp.get('utm_source'),
    utm_medium: sp.get('utm_medium'),
    utm_campaign: sp.get('utm_campaign'),
    utm_content: sp.get('utm_content'),
  };
  sessionStorage.setItem(UTM_KEY, JSON.stringify(utm));
  return utm;
}

/**
 * Track a conversion event. Safe to call anywhere — never throws.
 *
 * @param event - Event name (e.g. 'checkout_view', 'lp_click_cta'). Max 64 chars.
 * @param props - Arbitrary JSON-safe properties (no PII!). Max ~2KB serialized.
 */
export function track(event: AnalyticsEvent, props: Record<string, string | number | boolean | null> = {}): void {
  try {
    // Guard: reject oversized or empty events
    if (!event || event.length > MAX_EVENT_LEN) return;
    const propsStr = JSON.stringify(props);
    if (propsStr.length > MAX_PROPS_LEN) return;

    initAuth();

    const sessionId = getSessionId();
    const utm = getUtm();

    supabase
      .from('analytics_events')
      .insert([{
        session_id: sessionId,
        event,
        path: window.location.pathname,
        props,
        user_id: cachedUserId,
        ...utm,
      }])
      .then(({ error }) => {
        if (error) console.warn('[track] insert failed:', error.message);
      });
  } catch {
    // Tracking must never break the app
  }
}
