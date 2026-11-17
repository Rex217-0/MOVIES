import { firebaseWebConfig } from './firebaseConfig';

const AUTH_KEY = 'movies_firebase_anon_auth';
const API_ROOT = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseWebConfig.projectId)}/databases/(default)/documents`;

type AuthSession = {
  uid: string;
  idToken: string;
  refreshToken: string;
  expiresAt: number;
};

export type SavedMovie = {
  id: string;
  title: string;
  brief: string;
  status: 'running' | 'done' | 'error';
  minutes: number;
  scenes: number | null;
  seconds: number | null;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  asset: { name: string; bytes: number; kind: string; title: string } | null;
};

function readSession(): AuthSession | null {
  try {
    const value = localStorage.getItem(AUTH_KEY);
    return value ? JSON.parse(value) as AuthSession : null;
  } catch {
    return null;
  }
}

function saveSession(session: AuthSession) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(session));
}

async function authRequest(path: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/${path}?key=${encodeURIComponent(firebaseWebConfig.apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = String(result?.error?.message ?? 'AUTH_ERROR');
    // Both codes mean the Anonymous provider is switched off in the console.
    // ADMIN_ONLY_OPERATION is what identitytoolkit returns when Anonymous
    // sign-up is disabled; OPERATION_NOT_ALLOWED is the older wording.
    if (code.includes('ADMIN_ONLY_OPERATION') || code.includes('OPERATION_NOT_ALLOWED')) {
      throw new Error('I-enable ang Anonymous sign-in sa Firebase Console → Authentication → Sign-in method, tapos i-Save.');
    }
    throw new Error(`Firebase Authentication error: ${code}`);
  }
  return result;
}

export async function ensureAnonymousSession(): Promise<AuthSession> {
  if (!firebaseWebConfig.apiKey) throw new Error('Walang Firebase Web API key sa config.');
  const current = readSession();
  if (current && current.expiresAt > Date.now() + 60_000) return current;

  if (current?.refreshToken) {
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refreshToken });
    const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(firebaseWebConfig.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const refreshed = await response.json().catch(() => ({}));
    if (response.ok && refreshed.id_token) {
      const session = {
        uid: refreshed.user_id,
        idToken: refreshed.id_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: Date.now() + Number(refreshed.expires_in || 3600) * 1000,
      };
      saveSession(session);
      return session;
    }
  }

  const result = await authRequest('accounts:signUp', { returnSecureToken: true });
  const session = {
    uid: result.localId,
    idToken: result.idToken,
    refreshToken: result.refreshToken,
    expiresAt: Date.now() + Number(result.expiresIn || 3600) * 1000,
  };
  saveSession(session);
  return session;
}

function encodeFields(movie: SavedMovie) {
  return {
    payload: { stringValue: JSON.stringify(movie) },
    createdAt: { timestampValue: movie.startedAt },
  };
}

export async function saveMovieHistory(movie: SavedMovie): Promise<void> {
  const session = await ensureAnonymousSession();
  const docPath = `users/${encodeURIComponent(session.uid)}/movie_history/${encodeURIComponent(movie.id)}`;
  const response = await fetch(`${API_ROOT}/${docPath}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${session.idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: encodeFields(movie) }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const status = body?.error?.status || String(response.status);
    const hint = status === '404'
      ? 'Wala pa ang Firestore database. Gumawa nito sa Firebase Console → Firestore Database → Create database.'
      : 'I-deploy ang firestore.rules at tiyaking enabled ang Firestore.';
    throw new Error(`Hindi na-save sa Firestore (${status}). ${hint}`);
  }
}

export async function listMovieHistory(): Promise<SavedMovie[]> {
  const session = await ensureAnonymousSession();
  const url = `${API_ROOT}/users/${encodeURIComponent(session.uid)}/movie_history?pageSize=50`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${session.idToken}` } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const status = body?.error?.status || String(response.status);
    const hint = status === '404'
      ? 'Wala pa ang Firestore database. Gumawa nito sa Firebase Console → Firestore Database → Create database.'
      : 'I-deploy ang firestore.rules.';
    throw new Error(`Hindi mabasa ang Firestore history (${status}). ${hint}`);
  }
  const result = await response.json().catch(() => ({}));
  return (result.documents ?? []).flatMap((doc: any) => {
    const raw = doc.fields?.payload?.stringValue;
    if (!raw) return [];
    try { return [JSON.parse(raw) as SavedMovie]; } catch { return []; }
  }).sort((a: SavedMovie, b: SavedMovie) => b.startedAt.localeCompare(a.startedAt));
}
