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
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    // 1) Authenticate
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await serviceClient.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // 2) Authorize via user_roles table
    const { data: roleRows, error: roleErr } = await serviceClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .in("role", ["admin", "risk_officer"]);
    if (roleErr) throw roleErr;
    if (!roleRows || roleRows.length === 0) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // 3) Fetch resolved accounts in window (source of truth)
    const sinceIso = new Date(Date.now() - 30 * 86400000).toISOString();

    const { data: accounts, error: accErr } = await serviceClient
      .from("accounts")
      .select("cohort_id, status, updated_at")
      .in("status", ["passed", "failed_confirmed"])
      .gte("updated_at", sinceIso);
    if (accErr) throw accErr;

    // 4) Fetch ALL cohorts referenced by those accounts (not filtered by is_active)
    const referencedCohortIds = [...new Set((accounts ?? []).map((a) => a.cohort_id))];

    let cohorts: { id: string; name: string; tier_id: string | null }[] = [];
    if (referencedCohortIds.length > 0) {
      const { data, error } = await serviceClient
        .from("cohorts")
        .select("id, name, tier_id")
        .in("id", referencedCohortIds);
      if (error) throw error;
      cohorts = data ?? [];
    }

    // 5) Map cohorts → tier keys. tier_id is a string key ("starter"|"pro"|"elite") or null.
    const cohortToTier = new Map<string, string>();
    let unmappedCohortCount = 0;
    let unknownTierKeyCount = 0;

    const validTierKeys = new Set(["starter", "pro", "elite"]);

    for (const c of cohorts) {
      if (c.tier_id && validTierKeys.has(c.tier_id)) {
        cohortToTier.set(c.id, c.tier_id);
      } else if (c.tier_id && !validTierKeys.has(c.tier_id)) {
        // tier_id set but doesn't match known keys — ops should fix
        unknownTierKeyCount++;
      } else {
        unmappedCohortCount++;
      }
    }

    // 6) Aggregate
    const knownTiers = [
      { id: "starter", name: "Starter" },
      { id: "pro", name: "Pro" },
      { id: "elite", name: "Elite" },
    ];
    const tierMap = new Map(knownTiers.map((t) => [t.id, { passed: 0, total: 0 }]));

    let mappedAccountCount = 0;
    for (const acc of accounts ?? []) {
      const tierId = cohortToTier.get(acc.cohort_id);
      if (!tierId) continue;
      mappedAccountCount++;
      const entry = tierMap.get(tierId)!;
      entry.total++;
      if (acc.status === "passed") entry.passed++;
    }

    const resolvedAccountCount = accounts?.length ?? 0;
    const unmappedAccountCount = resolvedAccountCount - mappedAccountCount;

    let sampleSizeTotal = 0;
    const tiers = knownTiers.map((t) => {
      const stats = tierMap.get(t.id)!;
      sampleSizeTotal += stats.total;
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
      JSON.stringify({
        tiers,
        unmappedCohortCount,
        unknownTierKeyCount,
        sampleSizeTotal,
        mappedAccountCount,
        unmappedAccountCount,
        resolvedAccountCount,
        windowDays: 30,
        asOf: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Cache-Control": "private, max-age=30",
        },
      }
    );
  } catch (err) {
    console.error("get-pass-rate-stats error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
});
