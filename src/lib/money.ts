/**
 * Money helpers — canonical representation is integer MICRO-GBP.
 * 1_000_000 micros = £1.00. 1 micro = £0.000001.
 *
 * Why micros: AI per-request charges are frequently below one penny
 * (e.g. £0.0042). Integer micros preserve those charges exactly through
 * the append-only ledger while keeping money out of float arithmetic.
 */

export const MICRO_PER_POUND = 1_000_000;

/** Parse a user-facing decimal string or number of pounds into micros (rounded). */
export function poundsToMicros(pounds: number): number {
  return Math.round(pounds * MICRO_PER_POUND);
}

/** Convert micros to a decimal pounds number (use for math, not display). */
export function microsToPounds(micros: number): number {
  return micros / MICRO_PER_POUND;
}

/**
 * Format micros as a GBP string for display.
 * - £1,234.56 for typical amounts
 * - £0.0042 (4dp) for sub-penny amounts so metered usage is visible
 */
export function formatGBP(micros: number, opts?: { force4dp?: boolean }): string {
  const sign = micros < 0 ? "-" : "";
  const abs = Math.abs(micros);
  const pounds = abs / MICRO_PER_POUND;
  const subPenny = opts?.force4dp || (abs > 0 && abs < 10_000);
  const value = pounds.toLocaleString("en-GB", {
    minimumFractionDigits: subPenny ? 4 : 2,
    maximumFractionDigits: subPenny ? 4 : 2,
  });
  return `${sign}£${value}`;
}

/** Round a float micro amount to an integer micro (transaction boundary). */
export function roundMicros(micros: number): number {
  return Math.round(micros);
}

/** Common credit package sizes (micros) — configurable, not final. */
export const CREDIT_PACKAGES = [
  { micros: poundsToMicros(10), label: "£10" },
  { micros: poundsToMicros(25), label: "£25" },
  { micros: poundsToMicros(50), label: "£50" },
  { micros: poundsToMicros(100), label: "£100" },
] as const;
