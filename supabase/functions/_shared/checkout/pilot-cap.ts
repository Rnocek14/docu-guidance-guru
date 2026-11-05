// Pilot seat cap: limits how many evaluations can be sold during the closed pilot.
// Configured via system_settings key `pilot_seat_cap` (number). Missing → DEFAULT. 0 or negative → no cap.

export const DEFAULT_PILOT_SEAT_CAP = 30
// Unpaid checkout sessions hold a seat for this long so we never oversell during checkout.
export const SESSION_HOLD_MINUTES = 30
export const PAID_STATUSES = ['queued', 'processing', 'fulfilled', 'failed']

export function parseSeatCap(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return DEFAULT_PILOT_SEAT_CAP
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_PILOT_SEAT_CAP // fail closed to default
  if (n <= 0) return null // explicitly uncapped
  return Math.floor(n)
}

export function isPilotFull(cap: number | null, seatsTaken: number): boolean {
  if (cap === null) return false
  return seatsTaken >= cap
}

// deno-lint-ignore no-explicit-any
export async function checkPilotCapacity(svc: any): Promise<{ full: boolean; cap: number | null; taken: number }> {
  const { data: setting } = await svc
    .from('system_settings').select('value').eq('key', 'pilot_seat_cap').maybeSingle()
  const cap = parseSeatCap(setting?.value)
  if (cap === null) return { full: false, cap, taken: 0 }

  const holdSince = new Date(Date.now() - SESSION_HOLD_MINUTES * 60_000).toISOString()
  const [paid, held] = await Promise.all([
    svc.from('checkout_fulfillment_queue').select('id', { count: 'exact', head: true }).in('status', PAID_STATUSES),
    svc.from('checkout_fulfillment_queue').select('id', { count: 'exact', head: true })
      .eq('status', 'session_created').gte('created_at', holdSince),
  ])
  if (paid.error || held.error) throw new Error('pilot capacity lookup failed')
  const taken = (paid.count ?? 0) + (held.count ?? 0)
  return { full: isPilotFull(cap, taken), cap, taken }
}
