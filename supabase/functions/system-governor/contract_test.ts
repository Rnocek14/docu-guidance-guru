import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;

Deno.test("governor response includes effectiveConfig, source, and lockState", async () => {
  // Sign in as admin to get a token
  const signInRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      email: Deno.env.get("TEST_ADMIN_EMAIL"),
      password: Deno.env.get("TEST_ADMIN_PASSWORD"),
    }),
  });
  const signInBody = await signInRes.json();

  // If no test admin creds, skip gracefully
  if (!signInBody.access_token) {
    console.warn("⚠ Skipping: no TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD configured");
    return;
  }

  const res = await fetch(`${SUPABASE_URL}/functions/v1/system-governor`, {
    headers: { Authorization: `Bearer ${signInBody.access_token}` },
  });
  const body = await res.json();

  assertEquals(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);

  // ── Core invariants ──
  assertExists(body.verdict, "verdict missing");
  assertEquals(
    ["safe", "not_safe", "error"].includes(body.verdict),
    true,
    `verdict must be safe|not_safe|error, got: ${body.verdict}`,
  );

  assertExists(body.source, "source missing");
  assertEquals(
    ["cron", "manual"].includes(body.source),
    true,
    `source must be cron|manual, got: ${body.source}`,
  );

  // ── effectiveConfig invariants ──
  assertExists(body.effectiveConfig, "effectiveConfig missing");
  assertEquals(typeof body.effectiveConfig.min_net_buffer, "number", "min_net_buffer must be number");
  assertEquals(typeof body.effectiveConfig.auto_lock, "boolean", "auto_lock must be boolean");
  assertEquals(typeof body.effectiveConfig.auto_unlock, "boolean", "auto_unlock must be boolean");
  assertEquals(typeof body.effectiveConfig.enabled, "boolean", "enabled must be boolean");
  assertEquals(typeof body.effectiveConfig.strict_launch_mode, "boolean", "strict_launch_mode must be boolean");
  assertEquals(typeof body.effectiveConfig.unlock_after_consecutive_safe, "number", "unlock_after_consecutive_safe must be number");

  // ── lockState invariants ──
  assertExists(body.lockState, "lockState missing");
  assertEquals(typeof body.lockState.inbound_paused, "boolean", "inbound_paused must be boolean");
  assertEquals(typeof body.lockState.outbound_paused, "boolean", "outbound_paused must be boolean");
  assertEquals(typeof body.lockState.intake_paused, "boolean", "intake_paused must be boolean");
  assertEquals(typeof body.lockState.intake_unknown, "boolean", "intake_unknown must be boolean");
  assertEquals(
    ["governor", "operator", "none"].includes(body.lockState.lock_owner),
    true,
    `lock_owner must be governor|operator|none, got: ${body.lockState.lock_owner}`,
  );

  // ── Domain results exist ──
  for (const domain of ["capital", "processor", "cohort", "riskEngine"]) {
    assertExists(body[domain], `${domain} domain missing`);
    assertEquals(typeof body[domain].safe, "boolean", `${domain}.safe must be boolean`);
    assertEquals(Array.isArray(body[domain].checks), true, `${domain}.checks must be array`);
  }
});
