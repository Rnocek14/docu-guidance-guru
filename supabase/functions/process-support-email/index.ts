import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const VALID_TAGS = [
  "payout_status",
  "breach_explanation",
  "account_issue",
  "billing_refund",
  "general_inquiry",
] as const;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "Server misconfiguration: missing Supabase env" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!OPENAI_API_KEY) {
    return new Response(JSON.stringify({ error: "Server misconfiguration: missing OPENAI_API_KEY" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const payload = await req.json();

    // Resend inbound webhook payload
    const fromAddress = payload.from || payload.sender || "";
    const toAddress = payload.to || "";
    const subject = payload.subject || "(no subject)";
    const bodyText = payload.text || payload.plain || payload.body || "";
    const bodyHtml = payload.html || null;
    const resendInboundId = payload.id || payload.message_id || null;

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Try to match sender to a user profile
    let matchedUserId: string | null = null;
    let matchedAccountId: string | null = null;
    let accountContext = "";

    const senderEmail = typeof fromAddress === "string"
      ? fromAddress
      : (fromAddress as { address?: string })?.address || String(fromAddress);

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("user_id, full_name, kyc_status, lifetime_paid_total")
      .eq("email", senderEmail)
      .maybeSingle();

    if (profile) {
      matchedUserId = profile.user_id;

      // Get their most recent account for context
      const { data: accounts } = await supabaseAdmin
        .from("accounts")
        .select("id, account_number, status, current_balance, starting_balance, trading_days_count, passed_at")
        .eq("user_id", profile.user_id)
        .order("created_at", { ascending: false })
        .limit(3);

      if (accounts && accounts.length > 0) {
        matchedAccountId = accounts[0].id;
        accountContext = accounts
          .map(
            (a) =>
              `Account ${a.account_number}: status=${a.status}, balance=$${a.current_balance}, trading_days=${a.trading_days_count}${a.passed_at ? ", passed" : ""}`
          )
          .join("\n");
      }

      // Get recent payouts
      if (matchedAccountId) {
        const { data: payouts } = await supabaseAdmin
          .from("payouts")
          .select("amount, status, requested_at, review_notes")
          .eq("account_id", matchedAccountId)
          .order("requested_at", { ascending: false })
          .limit(3);

        if (payouts && payouts.length > 0) {
          accountContext +=
            "\nRecent payouts:\n" +
            payouts
              .map(
                (p) =>
                  `$${p.amount} — ${p.status} (requested ${p.requested_at})`
              )
              .join("\n");
        }
      }

      // Get recent violations
      if (matchedAccountId) {
        const { data: violations } = await supabaseAdmin
          .from("flags")
          .select("flag_type, reason, severity, status, created_at")
          .eq("account_id", matchedAccountId)
          .order("created_at", { ascending: false })
          .limit(3);

        if (violations && violations.length > 0) {
          accountContext +=
            "\nRecent flags:\n" +
            violations
              .map((v) => `${v.flag_type}: ${v.reason} (${v.severity}, ${v.status})`)
              .join("\n");
        }
      }
    }

    // Call OpenAI for classification + draft reply
    const systemPrompt = `You are a support agent for Meridian, a trading evaluation platform. 
Your job is to:
1. Classify the email into exactly one tag: ${VALID_TAGS.join(", ")}
2. Write a concise summary (1-2 sentences)
3. Draft a professional, helpful reply

Rules:
- Never promise payout approvals — only admins can approve
- Never share internal risk scores or breach thresholds
- Be empathetic but factual
- If you have account context, reference specific data to be helpful
- Keep replies under 200 words
- Sign off as "Meridian Support Team"

Respond in JSON format:
{
  "tag": "one_of_the_valid_tags",
  "confidence": 0.0-1.0,
  "summary": "brief summary",
  "draft_reply": "the full reply email text"
}`;

    const userMessage = `Email from: ${senderEmail}
Subject: ${subject}
Body:
${bodyText}

${accountContext ? `\n--- Account Context ---\n${accountContext}` : "No matching account found for this sender."}`;

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.3,
        response_format: { type: "json_object" },
      }),
    });

    const openaiData = await openaiRes.json();

    if (!openaiRes.ok) {
      console.error("OpenAI error:", openaiData);
      // Still save the email even if AI fails
      const { error: insertErr } = await supabaseAdmin.from("support_emails").insert({
        from_address: senderEmail,
        to_address: typeof toAddress === "string" ? toAddress : String(toAddress),
        subject,
        body_text: bodyText,
        body_html: bodyHtml,
        tag: "general_inquiry",
        confidence: 0,
        ai_summary: null,
        draft_reply: null,
        matched_user_id: matchedUserId,
        matched_account_id: matchedAccountId,
        status: "new",
        resend_inbound_id: resendInboundId,
      });

      if (insertErr) console.error("Insert error:", insertErr);

      return new Response(
        JSON.stringify({ success: true, ai_failed: true, error: openaiData.error?.message }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const aiContent = openaiData.choices?.[0]?.message?.content || "{}";
    let parsed: { tag?: string; confidence?: number; summary?: string; draft_reply?: string };
    try {
      parsed = JSON.parse(aiContent);
    } catch {
      parsed = {};
    }

    const tag = VALID_TAGS.includes(parsed.tag as typeof VALID_TAGS[number])
      ? parsed.tag!
      : "general_inquiry";

    const { error: insertErr } = await supabaseAdmin.from("support_emails").insert({
      from_address: senderEmail,
      to_address: typeof toAddress === "string" ? toAddress : String(toAddress),
      subject,
      body_text: bodyText,
      body_html: bodyHtml,
      tag,
      confidence: parsed.confidence || 0,
      ai_summary: parsed.summary || null,
      draft_reply: parsed.draft_reply || null,
      matched_user_id: matchedUserId,
      matched_account_id: matchedAccountId,
      status: parsed.draft_reply ? "ready" : "new",
      resend_inbound_id: resendInboundId,
    });

    if (insertErr) {
      console.error("Insert error:", insertErr);
      return new Response(JSON.stringify({ success: false, error: insertErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Processed email from ${senderEmail}: tag=${tag}, confidence=${parsed.confidence}`);

    return new Response(
      JSON.stringify({ success: true, tag, confidence: parsed.confidence, summary: parsed.summary }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error processing support email:", error);
    return new Response(JSON.stringify({ success: false, error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
