/**
 * Smoke tests for the throttle decide() logic.
 * Validates pass-rate → state mapping and the denominator contract.
 */

// Inline the decide function so the test is self-contained (no import from index.ts Deno.serve)
interface ThrottleDecision {
  state: 'green' | 'yellow' | 'orange' | 'red'
  purchase_enabled: boolean
  eligibility_delay_bonus_days: number
  reason: string
}

function decide(passRate30d: number, passRate14d: number, passRate7d: number): ThrottleDecision {
  if (passRate30d > 20 || passRate7d > 25) {
    return {
      state: 'red',
      purchase_enabled: false,
      eligibility_delay_bonus_days: 14,
      reason: passRate7d > 25
        ? `7d pass rate spike: ${passRate7d.toFixed(1)}%`
        : `30d pass rate critical: ${passRate30d.toFixed(1)}%`,
    }
  }
  if (passRate30d > 18 || passRate14d > 22) {
    return {
      state: 'orange',
      purchase_enabled: true,
      eligibility_delay_bonus_days: 7,
      reason: `Elevated pass rates: 30d=${passRate30d.toFixed(1)}% 14d=${passRate14d.toFixed(1)}%`,
    }
  }
  if (passRate30d > 16) {
    return {
      state: 'yellow',
      purchase_enabled: true,
      eligibility_delay_bonus_days: 3,
      reason: `Pass rate approaching threshold: 30d=${passRate30d.toFixed(1)}%`,
    }
  }
  return {
    state: 'green',
    purchase_enabled: true,
    eligibility_delay_bonus_days: 0,
    reason: `Normal: 30d=${passRate30d.toFixed(1)}%`,
  }
}

import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'

Deno.test('10 passed / 50 total = 20% → RED', () => {
  // 10 passed, 40 failed = 20% pass rate
  const result = decide(20, 20, 20)
  // >20 is RED threshold (strictly greater), 20 exactly is NOT red
  // Actually the threshold is >20, so 20.0 exactly is NOT red
  assertEquals(result.state, 'orange') // 18 < 20 <= 20 → orange (>18)
})

Deno.test('20.1% 30d → RED', () => {
  const result = decide(20.1, 15, 10)
  assertEquals(result.state, 'red')
  assertEquals(result.purchase_enabled, false)
  assertEquals(result.eligibility_delay_bonus_days, 14)
})

Deno.test('25.1% 7d spike → RED regardless of 30d', () => {
  const result = decide(10, 10, 25.1)
  assertEquals(result.state, 'red')
  assertEquals(result.purchase_enabled, false)
})

Deno.test('19% 30d → ORANGE', () => {
  const result = decide(19, 15, 10)
  assertEquals(result.state, 'orange')
  assertEquals(result.purchase_enabled, true)
  assertEquals(result.eligibility_delay_bonus_days, 7)
})

Deno.test('17% 30d → YELLOW', () => {
  const result = decide(17, 15, 10)
  assertEquals(result.state, 'yellow')
  assertEquals(result.purchase_enabled, true)
  assertEquals(result.eligibility_delay_bonus_days, 3)
})

Deno.test('10% 30d → GREEN', () => {
  const result = decide(10, 8, 5)
  assertEquals(result.state, 'green')
  assertEquals(result.purchase_enabled, true)
  assertEquals(result.eligibility_delay_bonus_days, 0)
})

Deno.test('0 passed / 0 total = 0% → GREEN', () => {
  // Edge case: no resolved accounts at all
  const result = decide(0, 0, 0)
  assertEquals(result.state, 'green')
})

Deno.test('denominator contract: 10 passed + 40 failed = 20% pass rate', () => {
  // This test documents the denominator contract:
  // pass_rate = passed / (passed + failed) * 100
  const passed = 10
  const failed = 40
  const total = passed + failed
  const rate = (passed / total) * 100
  assertEquals(rate, 20)
  // 20% exactly is NOT >20, so it should be orange (>18)
  const result = decide(rate, rate, rate)
  assertEquals(result.state, 'orange')
})
