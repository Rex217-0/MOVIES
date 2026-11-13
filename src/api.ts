/**
 * Shared API client.
 *
 * The token is read from a `?token=` query parameter on first load and kept in
 * sessionStorage, so the app works behind the bearer-token middleware without a
 * login screen. EventSource cannot set headers, so the same token is appended
 * to the thought-stream URL.
 */

const TOKEN_STORAGE_KEY = 'direk_auth_token';

function readTokenFromUrl(): string | null {
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('token');
    if (token) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      url.searchParams.delete('token');
      window.history.replaceState({}, '', url.toString());
      return token;
    }
  } catch {
    // Non-browser environment.
  }
  return null;
}

export function getAuthToken(): string {
  try {
    return readTokenFromUrl() ?? sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/** fetch wrapper that attaches the bearer token. */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getAuthToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

/** URL for the SSE thought stream, with the token as a query parameter. */
export function thoughtStreamUrl(): string {
  const token = getAuthToken();
  return token
    ? `/api/pilot/thought-stream?token=${encodeURIComponent(token)}`
    : '/api/pilot/thought-stream';
}
