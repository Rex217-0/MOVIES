# Firebase Movie Maker setup

Movie Maker saves job history to the signed-in browser's Firebase user at: `users/{uid}/movie_history/{movieId}`.

## One-time Firebase Console setup

1. Open Firebase Console → Authentication → Sign-in method → enable Anonymous.
2. Open Firebase Console → Firestore Database → enable it for project `movies-app-d646b`.
3. Deploy the rules from repo root:
   `npx firebase-tools deploy --only firestore:rules --project movies-app-d646b`
4. Use the repo's browser config; do not commit a service-account JSON or Firebase Admin private key.

This project uses the public Web API key and Anonymous Auth, which is correct for browser-only movie history. The user ID is automatically created by Firebase and bound to that browser session.
