export function formatTimestamp(ts: number | null): string {
  if (!ts) {
    return 'never';
  }

  return new Date(ts).toLocaleString();
}

export function formatRecentResultTime(ts: number, now = Date.now()): string {
  const diffMs = Math.max(0, now - ts);
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 5) {
    return 'just now';
  }

  if (diffSec < 60) {
    return `${diffSec} seconds ago`;
  }

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin === 1) {
    return '1 minute ago';
  }

  if (diffMin < 60) {
    return `${diffMin} minutes ago`;
  }

  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
