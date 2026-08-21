export function fmtEta(s: number | null | undefined): string {
  if (s == null) return '—';
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

export function fmtMinNum(s: number | null | undefined): string {
  if (s == null) return '—';
  if (s < 45) return '0';
  return String(Math.round(s / 60));
}

export function clockAt(nowMs: number, addS: number | null | undefined): string {
  if (addS == null) return '—';
  const d = new Date(nowMs + addS * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtClock(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtAge(s: number): string {
  if (s < 5) return 'just now';
  if (s < 60) return `${Math.round(s)}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function fmtDelay(s: number | null | undefined): string {
  if (s == null) return '—';
  const m = Math.round(Math.abs(s) / 60);
  if (m < 1) return 'on time';
  return s > 0 ? `${m} min late` : `${m} min early`;
}

export function fmtKm(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

export const CONFIDENCE_LABEL: Record<string, string> = {
  live: 'Live',
  recent: 'Recent',
  estimated: 'Estimated',
  stale: 'No signal',
};

export const CONFIDENCE_COLOR: Record<string, string> = {
  live: '#22c55e',
  recent: '#f5a524',
  estimated: '#f5a524',
  stale: '#f0506e',
};
