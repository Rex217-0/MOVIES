/// <reference types="vite/client" />

/**
 * Public Firebase Web App configuration for the browser client.
 * Do not put Firebase Admin service-account credentials in this file.
 */
export const firebaseWebConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
  projectId: 'movies-app-d646b',
  messagingSenderId: '583359348232',
  appId: '1:583359348232:web:8dbe4ba0415fafe5801bbd',
} as const;

/** The Firebase Web SDK can initialize only after the Web API key is configured. */
export function hasFirebaseWebConfig(): boolean {
  return Boolean(firebaseWebConfig.apiKey && firebaseWebConfig.projectId && firebaseWebConfig.appId);
}
