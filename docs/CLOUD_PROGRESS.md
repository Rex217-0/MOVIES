# Firebase and Google Cloud progress (shared agent context)

This note gives OpenHands and other contributors the current repository context so work is collaborative rather than duplicated. It records **what the code/configuration shows**, not proof that the corresponding services are currently enabled or deployed in the cloud. Check Firebase Console / Google Cloud Console or run a safe, authorized status check before making claims about live cloud state.

## Firebase / Firestore — implemented in the repository

- The configured Firebase project is `movies-app-d646b` (`.firebaserc`, `src/firebaseConfig.ts`). The frontend config is public Firebase Web App configuration, not an Admin credential. Never add Admin private keys to browser code.
- Movie Maker includes anonymous Firebase Authentication and Firestore history sync. It stores records under `users/{uid}/movie_history/{movieId}` and refreshes/syncs history in the UI (`src/firebaseClient.ts`, `src/components/MovieMakerWithFirebase.tsx`).
- `firestore.rules` scopes Movie Maker history reads/writes to the authenticated user's own UID and validates the stored fields.
- The repo includes Firebase CLI configuration (`firebase.json`) and a setup guide (`docs/firebase-setup.md`) with the steps to enable Anonymous sign-in, create Firestore, and deploy rules.
- The Feature Film Factory has a local SQLite database whose MovieJobs and SceneJobs document shapes are designed to align with Firestore (`README.md`, `src/direk/factoryDb.ts`). The rules include corresponding collections: reads are organization-scoped and client writes require an `admin` custom claim. Admin SDK server access is not governed by Firestore rules.

## Google Cloud — implemented/integrated in the repository

- Google Drive API v3 integration is implemented for asset uploads/listing. It uses OAuth consent and the narrow `drive.file` scope, with setup and status/auth/callback routes (`src/direk/gdrive.ts`, `README.md`).
- Google Drive is optional: with valid OAuth setup, the app can upload files; without it, the `cloud_storage` connector produces a local ZIP instead.
- The documented setup is to enable Google Drive API, create a Web application OAuth client with the app callback URI, configure `GDRIVE_CLIENT_ID` / `GDRIVE_CLIENT_SECRET`, then authorize via `/api/direk/drive/auth`. Credentials and tokens must remain out of Git; token storage is intended to be local and access-restricted.
- The Feature Film Factory also documents a Kaggle-hosted Pilot reached via a Cloudflare tunnel (`KAGGLE_PILOT_URL`). This is an external worker, not a Google Cloud deployment and not part of this repository.

## Important verification boundary

The checked-in code, config, rules, and setup docs establish that these integrations have been built into the project. They do **not** by themselves establish that Firestore rules have been deployed, Anonymous Auth/Firestore are enabled, Google Drive API is enabled, OAuth consent has completed, or any cloud operation was tested successfully. Verify live status before marking those tasks complete. Do not invent achievements or report unverified cloud-console changes as fact.

## Collaboration checklist

1. Read the relevant existing implementation and tests before coding; avoid rebuilding completed features.
2. Report prior project work accurately and credit the project/team as shared work, not as the current agent's solo work.
3. For each new cloud task, state whether it is code/config work or a live-console/deployment task, and document evidence for any live verification.
4. Keep this note and the specific setup docs updated when implementation or verified service status changes.
