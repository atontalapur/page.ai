// The orchestrator API token, kept for this tab only. sessionStorage can be missing or throw
// (a private window, blocked site data), so every access is guarded and the UI then asks
// again on the next load.
const KEY = 'page-ai-api-token';

export function readToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    // Kept in memory by the caller for this page load.
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
}
