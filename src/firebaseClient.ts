import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAnalytics, isSupported } from 'firebase/analytics';
import { firebaseWebConfig } from './firebaseConfig';

export const firebaseApp = getApps().length
  ? getApp()
  : initializeApp(firebaseWebConfig);

// Analytics is browser-only and may be unsupported in privacy-focused browsers,
// local development, or server rendering. Keep app startup working in those cases.
export const analyticsReady =
  typeof window === 'undefined'
    ? Promise.resolve(null)
    : isSupported()
        .then(supported => (supported ? getAnalytics(firebaseApp) : null))
        .catch(() => null);
