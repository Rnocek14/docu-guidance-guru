import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = "https://sfxmgwkrjwuerfkqxokq.supabase.co";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

  try {
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: alertResult, error: rpcError } = await supabaseAdmin.rpc("check_liability_alert");

    if (rpcError) {
      console.error("RPC error:", rpcError);
      return new Response(JSON.stringify({ success: false, error: rpcError.message }), {
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
