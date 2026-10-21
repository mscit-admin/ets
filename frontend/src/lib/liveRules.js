// Timing and filtering rules of the live updates (GET /api/events, backend services/live.js). Plain data and
// functions, no imports: used by lib/live.js (the web's EventSource) and the mobile app's stream client
// (mobile/src/lib/live.ts), so both reconnect, debounce and fall back to polling the same way.
export const DEBOUNCE_MS = 400;        // several events in a row → one reload
export const POLL_MS = 30_000;         // reload period while the stream is unavailable
export const FALLBACK_AFTER = 3;       // failures in a row before polling starts
export const MAX_BACKOFF_MS = 60_000;
export const IDLE_CLOSE_MS = 3000;     // the stream stays open this long after the last screen stopped listening

// Wait before reconnecting after the n-th failure in a row: 1, 2, 4 … 60 s.
export const backoffMs = failures => Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (Math.max(1, failures) - 1));

// The JSON data of an event, or null (the hints are only hints: a bad one is ignored).
export function eventData(raw) {
  try { const d = JSON.parse(raw); return d && typeof d === 'object' ? d : null; } catch { return null; }
}

// Does a screen with this filter reload for msg? Messages without ids (and reconnect / visible / poll) always pass.
export const passesFilter = (msg, filter) => !(msg.reason === 'change' && (msg.dept_id || msg.app_id) && filter && !filter(msg));
