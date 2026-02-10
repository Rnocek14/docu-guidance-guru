// Shared symbol normalization — single source of truth for all adapters + reconciliation

const MONTH_CODES = 'FGHJKMNQUVXZ';
const KNOWN_BASE_SYMBOLS = new Set([
  'ES', 'NQ', 'YM', 'RTY', 'MES', 'MNQ', 'MYM', 'M2K',
  'CL', 'NG', 'HO', 'RB', 'MCL',
  'GC', 'SI', 'HG', 'PL', 'MGC',
  '6E', '6B', '6J', '6A', '6C', '6S', '6N', '6M',
  'ZB', 'ZN', 'ZT', 'ZF', 'UB',
  'ZC', 'ZS', 'ZW', 'ZM', 'ZL', 'LE', 'HE', 'GF',
]);

export function normalizeSymbol(symbol: string): string {
  if (!symbol) return '';

  const upper = symbol.trim().toUpperCase();

  // Handle prefix exchange codes (CME:NQZ5 -> NQZ5)
  const prefixSplit = upper.split(':');
  const preToken = prefixSplit.length > 1 ? prefixSplit[prefixSplit.length - 1] : upper;

  // Remove trailing punctuation
  const trimmed = preToken.replace(/[!]+$/g, '').replace(/[.]+$/g, '');

  // Split on vendor separators
  const token = trimmed.split(/[-._:]/)[0];

  // Remove non-alphanumerics
  const cleaned = token.replace(/[^A-Z0-9]/g, '');

  // Futures contract extraction
  const futuresMatch = cleaned.match(/^([A-Z0-9]+?)([FGHJKMNQUVXZ])(\d{1,4})?$/);
  if (futuresMatch) {
    const [, base, monthCode] = futuresMatch;
    if (MONTH_CODES.includes(monthCode) && KNOWN_BASE_SYMBOLS.has(base)) {
      return base;
    }
  }

  // Fallback: strip trailing digits if result is known
  const strippedDigits = cleaned.replace(/\d+$/, '');
  if (KNOWN_BASE_SYMBOLS.has(strippedDigits)) {
    return strippedDigits;
  }

  return cleaned;
}
