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

// Categories safe for auto-send (no money / risk / dispute topics)
const AUTO_SEND_SAFE_TAGS: string[] = ["general_inquiry"];

// Keywords that block auto-send regardless of confidence
const AUTO_SEND_BLOCK_KEYWORDS = [
  "payout", "withdraw", "refund", "chargeback", "dispute",
  "breach", "violation", "ban", "freeze", "blocked",
  "lawyer", "legal", "sue", "complaint", "scam",
  "angry", "furious", "unacceptable", "ridiculous",
];

// Cost constants for gpt-4o-mini (per 1M tokens, in cents)
const COST_PER_1M_INPUT = 15;   // $0.15 per 1M input tokens
const COST_PER_1M_OUTPUT = 60;  // $0.60 per 1M output tokens
const DAILY_TOKEN_CAP = 500_000;
const PER_EMAIL_MAX_TOKENS = 2_000;
const AI_MODEL = "gpt-4o-mini";

// Confidence thresholds
const CONFIDENCE_AUTO_TAG = 0.85;
const CONFIDENCE_REVIEW_SUGGESTED = 0.60;
const CONFIDENCE_AUTO_SEND = 0.92;

interface AiResult {
  tag: string;
  confidence: number;
  summary: string;
  draft_reply: string;
}

function detectBlockKeywords(text: string): string | null {
  const lower = text.toLowerCase();
  for (const kw of AUTO_SEND_BLOCK_KEYWORDS) {
    if (lower.includes(kw)) return kw;
  }
  return null;
}

function estimateCostCents(promptTokens: number, completionTokens: number): number {
  return (promptTokens * COST_PER_1M_INPUT + completionTokens * COST_PER_1M_OUTPUT) / 1_000_000;
}

function determineAutoSendable(
  tag: string,
  confidence: number,
  bodyText: string,
  subject: string,
): { auto_sendable: boolean; blocked_reason: string | null } {
  if (confidence < CONFIDENCE_AUTO_SEND) {
    return { auto_sendable: false, blocked_reason: `confidence_below_${CONFIDENCE_AUTO_SEND}` };
  }
  if (!AUTO_SEND_SAFE_TAGS.includes(tag)) {
    return { auto_sendable: false, blocked_reason: `tag_not_in_safe_list:${tag}` };
  }
  const blockedKw = detectBlockKeywords(`${subject} ${bodyText}`);
  if (blockedKw) {
    return { auto_sendable: false, blocked_reason: `blocked_keyword:${blockedKw}` };
  }
  return { auto_sendable: true, blocked_reason: null };
}

function determineStatus(confidence: number, hasDraft: boolean): string {
  if (confidence >= CONFIDENCE_AUTO_TAG && hasDraft) return "ready";
  if (confidence >= CONFIDENCE_REVIEW_SUGGESTED) return "review_suggested";
  return "needs_human";
}

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

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const payload = await req.json();

    const fromAddress = payload.from || payload.sender || "";
    const toAddress = payload.to || "";
    const subject = payload.subject || "(no subject)";
    const bodyText = payload.text || payload.plain || payload.body || "";
    const bodyHtml = payload.html || null;
    const resendInboundId = payload.id || payload.message_id || null;

    const senderEmail = typeof fromAddress === "string"
      ? fromAddress
      : (fromAddress as { address?: string })?.address || String(fromAddress);

    // --- Check daily token cap ---
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const { data: usageToday } = await supabaseAdmin
      .from("ai_usage_log")
      .select("total_tokens")
      .gte("created_at", todayStart.toISOString())
      .eq("function_name", "process-support-email");

    const totalTokensToday = (usageToday || []).reduce((sum, r) => sum + (r.total_tokens || 0), 0);
    const dailyCapReached = totalTokensToday >= DAILY_TOKEN_CAP;

    // --- Match sender to profile ---
    const { matchedUserId, matchedAccountId, accountContext } = await enrichSenderContext(supabaseAdmin, senderEmail);

    // --- AI Classification ---
    const aiStart = Date.now();
    let aiResult: AiResult | null = null;
    let aiError: string | null = null;
    let aiStatus: string = "pending";
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;

    if (dailyCapReached) {
      aiStatus = "skipped_cap";
      aiError = `Daily token cap reached (${totalTokensToday}/${DAILY_TOKEN_CAP})`;
      console.warn(aiError);
    } else {
      try {
        const { result, usage, error } = await classifyWithOpenAI(
          OPENAI_API_KEY, senderEmail, subject, bodyText, accountContext,
        );
        if (result) {
          aiResult = result;
          aiStatus = "complete";
        } else {
          aiStatus = "failed";
          aiError = error || "Unknown AI error";
        }
        promptTokens = usage?.prompt_tokens || 0;
        completionTokens = usage?.completion_tokens || 0;
        totalTokens = usage?.total_tokens || 0;
      } catch (e) {
        aiStatus = "failed";
        aiError = String(e);
        console.error("AI classification error:", e);
      }
    }

    const aiLatencyMs = Date.now() - aiStart;

    const tag = aiResult && VALID_TAGS.includes(aiResult.tag as typeof VALID_TAGS[number])
      ? aiResult.tag
      : "general_inquiry";

    const confidence = aiResult?.confidence || 0;
    const emailStatus = aiResult ? determineStatus(confidence, !!aiResult.draft_reply) : "new";
    const { auto_sendable, blocked_reason } = aiResult
      ? determineAutoSendable(tag, confidence, bodyText, subject)
      : { auto_sendable: false, blocked_reason: "ai_not_available" };

    // --- Insert email record ---
    const { error: insertErr } = await supabaseAdmin.from("support_emails").insert({
      from_address: senderEmail,
      to_address: typeof toAddress === "string" ? toAddress : String(toAddress),
      subject,
      body_text: bodyText,
      body_html: bodyHtml,
      tag,
      confidence,
      ai_summary: aiResult?.summary || null,
      draft_reply: aiResult?.draft_reply || null,
      matched_user_id: matchedUserId,
      matched_account_id: matchedAccountId,
      status: emailStatus,
      resend_inbound_id: resendInboundId,
      // AI telemetry
      ai_status: aiStatus,
      ai_model: aiStatus === "complete" ? AI_MODEL : null,
      ai_tokens_used: totalTokens || null,
      ai_latency_ms: aiLatencyMs,
      ai_attempted_at: new Date().toISOString(),
      ai_error: aiError,
      // Auto-send
      auto_sendable,
      auto_send_blocked_reason: blocked_reason,
    });

    if (insertErr) {
      console.error("Insert error:", insertErr);
      return new Response(JSON.stringify({ success: false, error: insertErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Log AI usage for cost tracking ---
    if (aiStatus !== "skipped_cap") {
      await supabaseAdmin.from("ai_usage_log").insert({
        function_name: "process-support-email",
        model: AI_MODEL,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        latency_ms: aiLatencyMs,
        estimated_cost_cents: estimateCostCents(promptTokens, completionTokens),
        error: aiError,
      });
    }

    console.log(
      `Processed email from ${senderEmail}: tag=${tag}, confidence=${confidence}, ` +
      `ai_status=${aiStatus}, tokens=${totalTokens}, latency=${aiLatencyMs}ms, ` +
      `auto_sendable=${auto_sendable}, status=${emailStatus}`
    );

    return new Response(
      JSON.stringify({
        success: true,
        tag,
        confidence,
        summary: aiResult?.summary,
        ai_status: aiStatus,
        email_status: emailStatus,
        auto_sendable,
        tokens_used: totalTokens,
        latency_ms: aiLatencyMs,
      }),
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

// --- Helper: Enrich sender context from DB ---
async function enrichSenderContext(
  supabaseAdmin: ReturnType<typeof createClient>,
  senderEmail: string,
): Promise<{ matchedUserId: string | null; matchedAccountId: string | null; accountContext: string }> {
  let matchedUserId: string | null = null;
  let matchedAccountId: string | null = null;
  let accountContext = "";

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("user_id, full_name, kyc_status, lifetime_paid_total")
    .eq("email", senderEmail)
    .maybeSingle();

  if (!profile) return { matchedUserId, matchedAccountId, accountContext };

  matchedUserId = profile.user_id;

  const { data: accounts } = await supabaseAdmin
    .from("accounts")
    .select("id, account_number, status, current_balance, starting_balance, trading_days_count, passed_at")
    .eq("user_id", profile.user_id)
    .order("created_at", { ascending: false })
    .limit(3);

  if (accounts && accounts.length > 0) {
    matchedAccountId = accounts[0].id;
    accountContext = accounts
      .map(a => `Account ${a.account_number}: status=${a.status}, balance=$${a.current_balance}, trading_days=${a.trading_days_count}${a.passed_at ? ", passed" : ""}`)
      .join("\n");

    // Recent payouts
    const { data: payouts } = await supabaseAdmin
      .from("payouts")
      .select("amount, status, requested_at, review_notes")
      .eq("account_id", matchedAccountId)
      .order("requested_at", { ascending: false })
      .limit(3);

    if (payouts?.length) {
      accountContext += "\nRecent payouts:\n" +
        payouts.map(p => `$${p.amount} — ${p.status} (requested ${p.requested_at})`).join("\n");
    }

    // Recent flags
    const { data: violations } = await supabaseAdmin
      .from("flags")
      .select("flag_type, reason, severity, status, created_at")
      .eq("account_id", matchedAccountId)
      .order("created_at", { ascending: false })
      .limit(3);

    if (violations?.length) {
      accountContext += "\nRecent flags:\n" +
        violations.map(v => `${v.flag_type}: ${v.reason} (${v.severity}, ${v.status})`).join("\n");
    }
  }

  return { matchedUserId, matchedAccountId, accountContext };
}

// --- Helper: Call OpenAI for classification ---
async function classifyWithOpenAI(
  apiKey: string,
  senderEmail: string,
  subject: string,
  bodyText: string,
  accountContext: string,
): Promise<{
  result: AiResult | null;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  error: string | null;
}> {
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
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.3,
      max_tokens: PER_EMAIL_MAX_TOKENS,
      response_format: { type: "json_object" },
    }),
  });

  const openaiData = await openaiRes.json();

  if (!openaiRes.ok) {
    console.error("OpenAI error:", openaiData);
    return { result: null, usage: null, error: openaiData.error?.message || "OpenAI request failed" };
  }

  const usage = openaiData.usage || null;
  const aiContent = openaiData.choices?.[0]?.message?.content || "{}";

  let parsed: Partial<AiResult>;
  try {
    parsed = JSON.parse(aiContent);
  } catch {
    return { result: null, usage, error: "Failed to parse AI JSON response" };
  }

  return {
    result: {
      tag: parsed.tag || "general_inquiry",
      confidence: parsed.confidence || 0,
      summary: parsed.summary || "",
      draft_reply: parsed.draft_reply || "",
    },
    usage,
    error: null,
  };
}
