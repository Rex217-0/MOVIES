/// <reference types="vite/client" />

/**
 * Public Firebase Web App configuration. These browser identifiers are not
 * service-account credentials; protect data with Firebase Auth and security
 * rules, and never put Admin SDK private keys in the frontend.
 */
export const firebaseWebConfig = {
  apiKey: 'AIzaSyApvx_7UfNmUAgDX7p7spmb3FWeaHrdSqo',
  authDomain: 'movies-app-d646b.firebaseapp.com',
  projectId: 'movies-app-d646b',
  storageBucket: 'movies-app-d646b.firebasestorage.app',
  messagingSenderId: '583359348232',
  appId: '1:583359348232:web:8dbe4ba0415fafe5801bbd',
  measurementId: 'G-JJBTVMSTZK',
} as const;
