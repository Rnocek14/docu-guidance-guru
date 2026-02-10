import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify caller is authenticated admin/risk_officer
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Verify the user's JWT and check role
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check admin role
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);
    const { data: profile } = await serviceClient
      .from("profiles")
      .select("user_id")
      .eq("user_id", user.id)
      .single();

    const userRole = user.app_metadata?.user_role;
    if (!["admin", "risk_officer"].includes(userRole)) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Compute rolling 30-day pass rate per tier using service role (bypasses RLS)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    const { data: cohorts, error: cohortErr } = await serviceClient
      .from("cohorts")
      .select("id, name, tier_id, cohort_phase")
      .eq("is_active", true);
    if (cohortErr) throw cohortErr;

    const { data: accounts, error: accErr } = await serviceClient
      .from("accounts")
      .select("cohort_id, status, updated_at")
      .in("status", ["passed", "failed_confirmed"])
      .gte("updated_at", thirtyDaysAgo);
    if (accErr) throw accErr;

    // Map cohorts to tiers
    const cohortToTier = new Map<string, string>();
    for (const c of cohorts ?? []) {
      if (c.tier_id) cohortToTier.set(c.id, c.tier_id);
      else if (c.cohort_phase === "evaluation") cohortToTier.set(c.id, "starter");
    }

    const tierMap = new Map<string, { passed: number; total: number; tierName: string }>();
    // Initialize known tiers
    const knownTiers = [
      { id: "starter", name: "Starter" },
      { id: "pro", name: "Pro" },
      { id: "elite", name: "Elite" },
    ];
    for (const t of knownTiers) {
      tierMap.set(t.id, { passed: 0, total: 0, tierName: t.name });
    }

    for (const acc of accounts ?? []) {
      const tierId = cohortToTier.get(acc.cohort_id);
      if (!tierId) continue;
      const entry = tierMap.get(tierId) ?? { passed: 0, total: 0, tierName: tierId };
      entry.total++;
      if (acc.status === "passed") entry.passed++;
      tierMap.set(tierId, entry);
    }

    const results = knownTiers.map((t) => {
      const stats = tierMap.get(t.id)!;
      const passRate = stats.total > 0 ? (stats.passed / stats.total) * 100 : 0;
      return {
        tierName: stats.tierName,
        passRate: Math.round(passRate * 10) / 10,
        breakEven: 17,
        inversion: 22,
        passed: stats.passed,
        total: stats.total,
      };
    });

    return new Response(JSON.stringify({ tiers: results }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("get-pass-rate-stats error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
