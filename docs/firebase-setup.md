# Firebase Movie Maker setup

Movie Maker saves job history to the signed-in browser's Firebase user at:
`users/{uid}/movie_history/{movieId}`. The current implementation creates an anonymous Firebase Authentication user, so history remains associated with that browser's anonymous account (clearing browser storage may lose access).

## One-time Firebase Console setup

1. In Firebase Console, open **Authentication → Sign-in method** and enable **Anonymous**.
2. Confirm Cloud Firestore is enabled for project `movies-app-d646b`.
3. From the repository root, install the Firebase CLI if needed and deploy only the rules:
   `npx firebase-tools deploy --only firestore:rules --project movies-app-d646b`
4. Redeploy the app after the GitHub commit is built. No Admin private key or service-account JSON is required for this browser-side, owner-scoped Firestore history.

The Web API key is a public Firebase client identifier. Restrict its API usage in Google Cloud where practical. Do not put service-account private keys in browser code or GitHub. Firestore rules are enforced for this client API; never switch these rules to public read/write.
