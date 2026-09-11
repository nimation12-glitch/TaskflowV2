/**
 * Wraps a backend call so a single missing/erroring endpoint degrades that one
 * section instead of throwing past Promise.all() and taking down the whole page
 * (which is what dashboard/error.tsx's full-page boundary would otherwise catch).
 *
 * This matters right now because the /compute/* and /account/ssh-keys endpoints
 * are new and may not be deployed on the backend yet — every page that touches
 * them should stay usable, just with those specific sections showing an
 * "unavailable" state rather than crashing.
 */
export async function safe<T>(promise: Promise<T>, fallback: T): Promise<{ data: T; ok: boolean }> {
  try {
    const data = await promise;
    return { data, ok: true };
  } catch (err) {
    console.error("[taskflow] non-fatal backend call failed:", err);
    return { data: fallback, ok: false };
  }
}
