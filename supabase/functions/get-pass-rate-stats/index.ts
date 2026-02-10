import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Cache-Control": "private, max-age=30",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 1) Authenticate: verify JWT via Supabase auth
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    // Extract token and verify via admin API
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await serviceClient.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2) Authorize: check role from user_roles table via service role (bypasses RLS)
    const { data: roleRows, error: roleErr } = await serviceClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .in("role", ["admin", "risk_officer"]);

    if (roleErr) throw roleErr;
    if (!roleRows || roleRows.length === 0) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3) Compute rolling 30-day pass rate per tier
    const sinceIso = new Date(Date.now() - 30 * 86400000).toISOString();

    const [cohortsRes, accountsRes] = await Promise.all([
      serviceClient
        .from("cohorts")
        .select("id, name, tier_id, cohort_phase")
        .eq("is_active", true),
      serviceClient
        .from("accounts")
        .select("cohort_id, status, updated_at")
        .in("status", ["passed", "failed_confirmed"])
        .gte("updated_at", sinceIso),
    ]);

    if (cohortsRes.error) throw cohortsRes.error;
    if (accountsRes.error) throw accountsRes.error;

    const cohorts = cohortsRes.data ?? [];
    const accounts = accountsRes.data ?? [];

    // 4) Map cohorts to tiers — track unmapped cohorts for ops visibility
    const cohortToTier = new Map<string, string>();
    const unmappedCohorts: string[] = [];

    for (const c of cohorts) {
      if (c.tier_id) {
        cohortToTier.set(c.id, c.tier_id);
      } else {
        unmappedCohorts.push(c.name || c.id);
      }
    }

    const knownTiers = [
      { id: "starter", name: "Starter" },
      { id: "pro", name: "Pro" },
      { id: "elite", name: "Elite" },
    ];

    const tierMap = new Map<string, { passed: number; total: number }>();
    for (const t of knownTiers) {
      tierMap.set(t.id, { passed: 0, total: 0 });
    }

    for (const acc of accounts) {
      const tierId = cohortToTier.get(acc.cohort_id);
      if (!tierId) continue;
      const entry = tierMap.get(tierId);
      if (!entry) continue;
      entry.total++;
      if (acc.status === "passed") entry.passed++;
    }

    const tiers = knownTiers.map((t) => {
      const stats = tierMap.get(t.id)!;
      const passRate = stats.total > 0
        ? Math.round((stats.passed / stats.total) * 1000) / 10
        : 0;
      return {
        tierName: t.name,
        passRate,
        breakEven: 17,
        inversion: 22,
        passed: stats.passed,
        total: stats.total,
      };
    });

    return new Response(
      JSON.stringify({ tiers, unmappedCohorts }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("get-pass-rate-stats error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
