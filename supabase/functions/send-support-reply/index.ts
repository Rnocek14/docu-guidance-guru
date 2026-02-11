import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "Server misconfiguration: missing Supabase env" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!RESEND_API_KEY) {
    return new Response(JSON.stringify({ error: "Server misconfiguration: missing RESEND_API_KEY" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { email_id, reply_text, user_id } = await req.json();

    if (!email_id || !reply_text) {
      return new Response(JSON.stringify({ error: "email_id and reply_text are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Fetch the original email
    const { data: email, error: fetchErr } = await supabaseAdmin
      .from("support_emails")
      .select("*")
      .eq("id", email_id)
      .single();

    if (fetchErr || !email) {
      return new Response(JSON.stringify({ error: "Email not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (email.status === "sent") {
      return new Response(JSON.stringify({ error: "Reply already sent" }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Send via Resend
    const replySubject = email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Meridian Support <onboarding@resend.dev>",
        to: [email.from_address],
        subject: replySubject,
        text: reply_text,
      }),
    });

    const resendData = await resendRes.json();

    if (!resendRes.ok) {
      console.error("Resend error:", resendData);
      await supabaseAdmin
        .from("support_emails")
        .update({ status: "failed", error: resendData.message || "Resend API error" })
        .eq("id", email_id);

      return new Response(
        JSON.stringify({ success: false, error: resendData.message || "Failed to send" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Mark as sent
    await supabaseAdmin
      .from("support_emails")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        sent_by: user_id || null,
        draft_reply: reply_text,
        draft_approved: true,
        resend_message_id: resendData.id || null,
        error: null,
      })
      .eq("id", email_id);

    console.log(`Reply sent for email ${email_id} to ${email.from_address}`);

    return new Response(
      JSON.stringify({ success: true, resend_id: resendData.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error sending reply:", error);
    return new Response(JSON.stringify({ success: false, error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
