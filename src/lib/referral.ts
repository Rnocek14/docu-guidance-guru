/**
 * Referral attribution utility.
 *
 * - Captures `?ref=CODE` from URL once and pins to localStorage for 30 days.
 * - Survives refreshes, multi-tab, account creation, delayed purchases.
 * - Code is normalized to UPPERCASE; only [A-Z0-9_-]{3,32}.
 * - First-touch wins (does not overwrite an existing valid cookie within window).
 */

const KEY = 'mrd_ref';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CODE_RE = /^[A-Z0-9_-]{3,32}$/;

interface Stored {
  code: string;
  capturedAt: number;
}

function read(): Stored | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored;
    if (!parsed?.code || !CODE_RE.test(parsed.code)) return null;
    if (Date.now() - parsed.capturedAt > TTL_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Read URL once and store ref code if valid. First-touch wins. */
export function captureReferralFromUrl(): void {
  try {
    const sp = new URLSearchParams(window.location.search);
    const raw = sp.get('ref');
    if (!raw) return;
    const code = raw.trim().toUpperCase();
    if (!CODE_RE.test(code)) return;
    const existing = read();
    if (existing) return; // first-touch wins within TTL
    localStorage.setItem(KEY, JSON.stringify({ code, capturedAt: Date.now() } satisfies Stored));
  } catch {
    /* ignore */
  }
}

/** Current attributed code, or null. */
export function getReferralCode(): string | null {
  return read()?.code ?? null;
}

/** Clear after a successful purchase (caller's choice). */
export function clearReferral(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** Build a shareable referral URL for a given code. */
export function buildReferralUrl(code: string, path: string = '/'): string {
  if (typeof window === 'undefined') return `${path}?ref=${code}`;
  const url = new URL(path, window.location.origin);
  url.searchParams.set('ref', code);
  return url.toString();
}