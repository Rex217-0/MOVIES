# Firebase Web App setup

The web app's public Firebase identifiers are kept in `src/firebaseConfig.ts`:

- Project ID: `movies-app-d646b`
- Messaging sender ID: `583359348232`
- App ID: `1:583359348232:web:8dbe4ba0415fafe5801bbd`

Set `VITE_FIREBASE_API_KEY` in the frontend build/deployment environment using the Web API key shown in Firebase Console under **Project settings → General → Your apps → movie_app**. The API key is a public web-app identifier, not a service-account private key; configure API-key restrictions as appropriate.

This repository currently uses a server-rendered React/Vite frontend and an Express API. The config module is a safe place for the Web App values, but Firebase client SDK initialization and sign-in are not added yet. Do not copy the standalone sample Express server over the existing `server.ts`.

For server-side Firestore on Google Cloud Run, prefer the Cloud Run service's attached service account and Application Default Credentials. Do not add a downloaded service-account JSON or private key to the repository. Grant the Cloud Run service account only the Firestore/Storage roles the app needs.
