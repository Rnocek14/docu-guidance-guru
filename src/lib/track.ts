import { supabase } from '@/integrations/supabase/client';

/**
 * Lightweight conversion-tracking utility.
 *
 * - Generates a stable session_id in sessionStorage
 * - Captures UTM params once per session from the URL
 * - Fire-and-forget: never throws, never blocks UI
 * - Never logs PII (no emails, no payment refs)
 */

const SESSION_KEY = 'ra_sid';
const UTM_KEY = 'ra_utm';

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
 * @param event - Event name (e.g. 'checkout_view', 'lp_click_cta')
 * @param props - Arbitrary JSON-safe properties (no PII!)
 */
export function track(event: string, props: Record<string, string | number | boolean | null> = {}): void {
  try {
    const sessionId = getSessionId();
    const utm = getUtm();

    // Get user_id if logged in, but don't await session
    const userId = supabase.auth.getSession().then(({ data }) => data?.session?.user?.id ?? null);

    userId.then((uid) => {
      supabase
        .from('analytics_events')
        .insert([{
          session_id: sessionId,
          event,
          path: window.location.pathname,
          props,
          user_id: uid,
          ...utm,
        }])
        .then(({ error }) => {
          if (error) console.warn('[track] insert failed:', error.message);
        });
    });
  } catch {
    // Tracking must never break the app
  }
}
