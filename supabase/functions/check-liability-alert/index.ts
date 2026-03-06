import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { constantTimeEqual } from "../_shared/crypto.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // ── Auth gate: X-Cron-Secret or admin JWT ──
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("FATAL: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return new Response(JSON.stringify({ success: false, error: "Server misconfiguration" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let cronSecret = Deno.env.get("CRON_SECRET") || "";

  if (!cronSecret || cronSecret.length < 16) {
    const tempClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: secretRow } = await tempClient
      .from("internal_secrets")
      .select("value")
      .eq("key", "CRON_SECRET")
      .single();
    cronSecret = (secretRow?.value ?? "").trim();
  }

  const incomingCronSecret = (req.headers.get("X-Cron-Secret") ?? "").trim();
  let isAuthorized = false;

  if (cronSecret && cronSecret.length >= 16 && incomingCronSecret) {
    isAuthorized = await constantTimeEqual(incomingCronSecret, cronSecret);
  }

  // Fallback: admin JWT
  if (!isAuthorized) {
    const authHeader = req.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
      if (anonKey) {
        const userClient = createClient(SUPABASE_URL, anonKey, {
          global: { headers: { Authorization: authHeader } },
        });
        const { data: userData } = await userClient.auth.getUser();
        if (userData?.user?.id) {
          const { data: roleRow } = await userClient
            .from("user_roles")
            .select("role")
            .eq("user_id", userData.user.id)
            .eq("role", "admin")
            .maybeSingle();
          if (roleRow) isAuthorized = true;
        }
      }
    }
  }

  if (!isAuthorized) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

  try {
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: alertResult, error: rpcError } = await supabaseAdmin.rpc("check_liability_alert");

    if (rpcError) {
      console.error("RPC error:", rpcError);
      return new Response(JSON.stringify({ success: false, error: "Internal server error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("Alert check result:", alertResult);

    // Send emails if alert fired + email channel enabled + recipients configured
    if (alertResult?.fired && alertResult?.channels?.includes("email") && RESEND_API_KEY) {
      const recipients = (alertResult.recipients as string[]) || [];
      
      if (recipients.length > 0) {
        const shortfall = "$" + Math.abs(alertResult.net_buffer || 0).toFixed(0);
        const html = `<h1 style="color:#dc2626;">⚠️ Net Buffer Negative</h1><p>Shortfall: ${shortfall}. Review pending payouts.</p>`;

        for (const email of recipients) {
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${RESEND_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: "Alerts <onboarding@resend.dev>",
              to: [email],
              subject: `⚠️ Liability Alert: ${shortfall}`,
              html,
            }),
          });
          console.log(`Email to ${email}: ${res.status}`);
          await res.text(); // Consume body
        }
      }
    }

    return new Response(JSON.stringify({ success: true, alert: alertResult }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error:", error);
    return new Response(JSON.stringify({ success: false, error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
