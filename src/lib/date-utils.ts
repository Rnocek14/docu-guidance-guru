/**
 * Safe date parsing for YYYY-MM-DD format without timezone ambiguity.
 * Parses the date as local time to avoid midnight UTC shifting dates.
 * 
 * @param dateStr - Date string in YYYY-MM-DD format (may include time component which is ignored)
 * @returns Date object in local time, or null if invalid/unparseable
 */
export function parseLocalDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr || typeof dateStr !== 'string') return null;
  
  try {
    // Match YYYY-MM-DD format (ignores any time component after)
    const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return null;
    
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    
    // Basic validation: month 1-12, day 1-31
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    
    const date = new Date(y, m - 1, d);
    
    // Validate the date is real (not NaN or invalid like Feb 30)
    // Check that the constructed date matches input (catches invalid dates like 2026-02-30)
    if (isNaN(date.getTime())) return null;
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
      return null; // Date rolled over (e.g., Feb 30 → Mar 2)
    }
    
    return date;
  } catch {
    return null;
  }
}
