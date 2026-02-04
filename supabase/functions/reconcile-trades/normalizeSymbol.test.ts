import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Copy of the normalizeSymbol function for testing
const MONTH_CODES = 'FGHJKMNQUVXZ';
const KNOWN_BASE_SYMBOLS = new Set([
  'ES', 'NQ', 'YM', 'RTY', 'MES', 'MNQ', 'MYM', 'M2K',
  'CL', 'NG', 'HO', 'RB', 'MCL',
  'GC', 'SI', 'HG', 'PL', 'MGC',
  '6E', '6B', '6J', '6A', '6C', '6S', '6N', '6M',
  'ZB', 'ZN', 'ZT', 'ZF', 'UB',
  'ZC', 'ZS', 'ZW', 'ZM', 'ZL', 'LE', 'HE', 'GF',
]);

function normalizeSymbol(symbol: string): string {
  if (!symbol) return '';
  
  const cleaned = symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  
  const futuresMatch = cleaned.match(/^([A-Z0-9]+?)([FGHJKMNQUVXZ])(\d{1,4})?$/);
  
  if (futuresMatch) {
    const [, base, monthCode] = futuresMatch;
    if (MONTH_CODES.includes(monthCode) && KNOWN_BASE_SYMBOLS.has(base)) {
      return base;
    }
  }
  
  const strippedDigits = cleaned.replace(/\d+$/, '');
  if (KNOWN_BASE_SYMBOLS.has(strippedDigits)) {
    return strippedDigits;
  }
  
  return cleaned;
}

// ============ TEST CASES ============

Deno.test("normalizeSymbol - standard futures contracts", () => {
  assertEquals(normalizeSymbol("NQZ5"), "NQ");
  assertEquals(normalizeSymbol("ESM24"), "ES");
  assertEquals(normalizeSymbol("CLZ5"), "CL");
  assertEquals(normalizeSymbol("GCG25"), "GC");
});

Deno.test("normalizeSymbol - micro futures", () => {
  assertEquals(normalizeSymbol("MNQU5"), "MNQ");
  assertEquals(normalizeSymbol("MESH24"), "MES");
  assertEquals(normalizeSymbol("M2KZ5"), "M2K");
});

Deno.test("normalizeSymbol - numeric-leading currencies", () => {
  assertEquals(normalizeSymbol("6EH6"), "6E");
  assertEquals(normalizeSymbol("6BM24"), "6B");
  assertEquals(normalizeSymbol("6JU5"), "6J");
});

Deno.test("normalizeSymbol - vendor suffix cleanup", () => {
  // Suffixes after the contract code get cleaned but may leave junk
  // The main goal is to handle punctuation like trailing ! or leading spaces
  assertEquals(normalizeSymbol("MNQU5!"), "MNQ"); // trailing !
  assertEquals(normalizeSymbol(" NQZ5 "), "NQ");  // whitespace
  assertEquals(normalizeSymbol("CLZ5."), "CL");   // trailing .
  
  // Note: NQZ5-CME becomes NQZ5CME which doesn't match pattern (CME suffix)
  // This is a known limitation - vendor exchange suffixes need special handling
  // For now, these return cleaned but not normalized
  assertEquals(normalizeSymbol("NQZ5-CME"), "NQZ5CME"); // known limitation
});

Deno.test("normalizeSymbol - equities should NOT be stripped", () => {
  // These should remain unchanged (not stripped)
  assertEquals(normalizeSymbol("AAPL"), "AAPL");
  assertEquals(normalizeSymbol("MSFT"), "MSFT");
  assertEquals(normalizeSymbol("GOOGL"), "GOOGL");
  assertEquals(normalizeSymbol("META"), "META");
  assertEquals(normalizeSymbol("NVDA"), "NVDA");
  assertEquals(normalizeSymbol("TSLA"), "TSLA");
});

Deno.test("normalizeSymbol - edge cases", () => {
  assertEquals(normalizeSymbol(""), "");
  assertEquals(normalizeSymbol("  NQ  "), "NQ");
  assertEquals(normalizeSymbol("nqz5"), "NQ"); // lowercase
  assertEquals(normalizeSymbol("ES"), "ES"); // already base
  assertEquals(normalizeSymbol("NQ"), "NQ"); // already base
});

Deno.test("normalizeSymbol - unknown symbols stay unchanged", () => {
  // Unknown futures-like patterns should NOT be stripped
  assertEquals(normalizeSymbol("XYZH24"), "XYZH24");
  assertEquals(normalizeSymbol("ABCZ5"), "ABCZ5");
});
