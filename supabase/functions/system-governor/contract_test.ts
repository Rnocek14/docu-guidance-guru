import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("system-governor contract invariants (cron path)", async () => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || Deno.env.get("VITE_SUPABASE_URL");
  const CRON_SECRET = Deno.env.get("CRON_SECRET");

  if (!SUPABASE_URL || !CRON_SECRET) {
    console.warn("⚠ Skipping: SUPABASE_URL / CRON_SECRET not configured");
    return;
  }

  const res = await fetch(`${SUPABASE_URL}/functions/v1/system-governor`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });

  const body = await res.json().catch(() => ({}));

  assertEquals(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);

  // ── Core invariants ──
  assertExists(body.verdict, "verdict missing");
  assertEquals(["safe", "not_safe"].includes(body.verdict), true, `verdict must be safe|not_safe, got: ${body.verdict}`);

  assertExists(body.source, "source missing");
  assertEquals(["cron", "manual"].includes(body.source), true, `source must be cron|manual, got: ${body.source}`);

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
  for (const domain of ["capital", "processor", "cohort", "riskEngine"] as const) {
    assertExists(body[domain], `${domain} domain missing`);
    assertEquals(typeof body[domain].safe, "boolean", `${domain}.safe must be boolean`);
    assertEquals(Array.isArray(body[domain].checks), true, `${domain}.checks must be array`);
  }
});
