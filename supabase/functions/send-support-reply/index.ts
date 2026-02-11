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
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!RESEND_API_KEY) {
    return new Response(JSON.stringify({ error: "Server misconfiguration: missing RESEND_API_KEY" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { email_id, reply_text, user_id } = await req.json();

    if (!email_id || !reply_text) {
      return new Response(JSON.stringify({ error: "email_id and reply_text are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id is required (must be staff)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Verify sender is staff
    const { data: roles } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", user_id);

    const staffRoles = ["admin", "support", "risk_officer"];
    const isStaff = roles?.some(r => staffRoles.includes(r.role));

    if (!isStaff) {
      return new Response(JSON.stringify({ error: "Unauthorized: must be staff to send replies" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch the original email
    const { data: email, error: fetchErr } = await supabaseAdmin
      .from("support_emails")
      .select("*")
      .eq("id", email_id)
      .single();

    if (fetchErr || !email) {
      return new Response(JSON.stringify({ error: "Email not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fail-closed: only allow sending from valid states
    const sendableStatuses = ["ready", "review_suggested", "needs_human", "new", "failed"];
    if (!sendableStatuses.includes(email.status)) {
      return new Response(JSON.stringify({ error: `Cannot send from status '${email.status}'` }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Detect if draft was edited (human override)
    const isOverride = email.draft_reply && reply_text !== email.draft_reply;

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

      // Log failed attempt
      await supabaseAdmin.from("support_email_actions").insert({
        email_id,
        action_type: "reply_failed",
        actor_user_id: user_id,
        metadata: { error: resendData.message || "Resend API error" },
      });

      await supabaseAdmin
        .from("support_emails")
        .update({ status: "failed" })
        .eq("id", email_id);

      return new Response(
        JSON.stringify({ success: false, error: resendData.message || "Failed to send" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Mark as sent + record override if applicable
    const updatePayload: Record<string, unknown> = {
      status: "sent",
      sent_at: new Date().toISOString(),
      sent_by: user_id,
      draft_reply: reply_text,
      draft_approved: true,
      resend_message_id: resendData.id || null,
    };

    if (isOverride) {
      updatePayload.human_override = true;
      updatePayload.overridden_by = user_id;
      updatePayload.overridden_at = new Date().toISOString();
      updatePayload.original_draft_reply = email.draft_reply;
    }

    await supabaseAdmin
      .from("support_emails")
      .update(updatePayload)
      .eq("id", email_id);

    // Log the action
    await supabaseAdmin.from("support_email_actions").insert({
      email_id,
      action_type: "reply_sent",
      actor_user_id: user_id,
      metadata: {
        resend_id: resendData.id,
        human_override: !!isOverride,
        reply_length: reply_text.length,
      },
    });

    console.log(`Reply sent for email ${email_id} to ${email.from_address} by ${user_id}`);

    return new Response(
      JSON.stringify({ success: true, resend_id: resendData.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error sending reply:", error);
    return new Response(JSON.stringify({ success: false, error: String(error) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
