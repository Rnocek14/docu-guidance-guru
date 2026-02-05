import { describe, it, expect } from 'vitest';
import { parseLocalDate } from './date-utils';

describe('parseLocalDate', () => {
  describe('valid dates', () => {
    it('parses YYYY-MM-DD correctly', () => {
      const result = parseLocalDate('2026-02-05');
      expect(result).not.toBeNull();
      expect(result!.getFullYear()).toBe(2026);
      expect(result!.getMonth()).toBe(1); // February (0-indexed)
      expect(result!.getDate()).toBe(5);
    });

    it('parses date with time component (ignores time)', () => {
      const result = parseLocalDate('2026-02-05T00:00:00Z');
      expect(result).not.toBeNull();
      expect(result!.getFullYear()).toBe(2026);
      expect(result!.getMonth()).toBe(1);
      expect(result!.getDate()).toBe(5);
    });

    it('parses date with timezone offset', () => {
      const result = parseLocalDate('2026-02-05T23:59:59-05:00');
      expect(result).not.toBeNull();
      expect(result!.getDate()).toBe(5); // Should still be Feb 5, not shifted
    });

    it('handles leap year dates', () => {
      const result = parseLocalDate('2024-02-29');
      expect(result).not.toBeNull();
      expect(result!.getMonth()).toBe(1);
      expect(result!.getDate()).toBe(29);
    });

    it('handles end of year', () => {
      const result = parseLocalDate('2026-12-31');
      expect(result).not.toBeNull();
      expect(result!.getMonth()).toBe(11);
      expect(result!.getDate()).toBe(31);
    });

    it('handles start of year', () => {
      const result = parseLocalDate('2026-01-01');
      expect(result).not.toBeNull();
      expect(result!.getMonth()).toBe(0);
      expect(result!.getDate()).toBe(1);
    });
  });

  describe('null/undefined/empty handling', () => {
    it('returns null for null input', () => {
      expect(parseLocalDate(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(parseLocalDate(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseLocalDate('')).toBeNull();
    });
  });

  describe('invalid date strings', () => {
    it('returns null for non-date string', () => {
      expect(parseLocalDate('not-a-date')).toBeNull();
    });

    it('returns null for partial date', () => {
      expect(parseLocalDate('2026-02')).toBeNull();
    });

    it('returns null for year only', () => {
      expect(parseLocalDate('2026')).toBeNull();
    });

    it('returns null for invalid month (13)', () => {
      expect(parseLocalDate('2026-13-40')).toBeNull();
    });

    it('returns null for invalid month (0)', () => {
      expect(parseLocalDate('2026-00-15')).toBeNull();
    });

    it('returns null for invalid day (0)', () => {
      expect(parseLocalDate('2026-02-00')).toBeNull();
    });

    it('returns null for invalid day (32)', () => {
      expect(parseLocalDate('2026-01-32')).toBeNull();
    });

    it('returns null for Feb 30', () => {
      expect(parseLocalDate('2026-02-30')).toBeNull();
    });

    it('returns null for Feb 29 in non-leap year', () => {
      expect(parseLocalDate('2025-02-29')).toBeNull();
    });

    it('returns null for April 31', () => {
      expect(parseLocalDate('2026-04-31')).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('handles date-like string with extra content after', () => {
      const result = parseLocalDate('2026-02-05 extra stuff');
      expect(result).not.toBeNull();
      expect(result!.getDate()).toBe(5);
    });

    it('returns null for wrong format (DD-MM-YYYY)', () => {
      expect(parseLocalDate('05-02-2026')).toBeNull();
    });

    it('returns null for wrong format (MM/DD/YYYY)', () => {
      expect(parseLocalDate('02/05/2026')).toBeNull();
    });
  });
});
