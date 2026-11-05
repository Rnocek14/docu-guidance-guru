import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { isPilotFull, parseSeatCap } from './pilot-cap.ts'

Deno.test('default pilot cap is 30 seats', () => {
  assertEquals(parseSeatCap(undefined), 30)
})

Deno.test('29 sold leaves one seat; 30 sold closes checkout', () => {
  assertEquals(isPilotFull(30, 29), false)
  assertEquals(isPilotFull(30, 30), true)
})

Deno.test('cap of 0 removes the limit', () => {
  assertEquals(parseSeatCap(0), null)
  assertEquals(isPilotFull(null, 10_000), false)
})

Deno.test('garbage setting falls back to 30, not unlimited', () => {
  assertEquals(parseSeatCap('abc'), 30)
})
