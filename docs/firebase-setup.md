# Firebase movie history setup

Movie Maker saves job history to the signed-in browser's Firebase user at
`users/{uid}/movie_history/{movieId}`. The client talks to Firebase directly over
the REST API (`src/firebaseClient.ts`) with Anonymous Auth and the public Web API
key in `src/firebaseConfig.ts`. No service-account key is used on the front end.

## Hindi kailangan ng Firebase ang paggawa ng video

**Mahalaga:** ang paggawa ng video ay tumatakbo sa server (`/api/direk/movie`,
ffmpeg sa Server-2), **hindi** sa Firebase. Kapag hindi ma-access ang Firebase,
hindi ito humaharang sa video — history lang ang hindi naka-save. Kung "hindi
gumagana ang video", tingnan ang server (ffmpeg, `GEMINI_API_KEY`, ComfyUI), hindi
ang Firebase. Ang video tab ay may dalawang hiwalay na mensahe: ang video job
mismo (sa itaas) at ang "Firebase movie history" (sa ibaba).

## One-time Firebase Console setup (project `movies-app-d646b`)

1. **Authentication → Sign-in method → Anonymous → Enable → Save.**
   Kung hindi ito naka-enable, ipapakita ng app ang:
   `Firebase Authentication error: ADMIN_ONLY_OPERATION`.
2. **Firestore Database → Create database.**
   Kung wala pa itong database, 404 ang REST call at ipapakita ng app ang:
   `Hindi mabasa ang Firestore history (404)`.
   Pumili ng location (hal. `asia-southeast1`) at **production mode**.
3. **I-deploy ang rules** mula sa repo root:
   ```bash
   npx firebase-tools deploy --only firestore:rules --project movies-app-d646b
   ```
   (Kailangan ng `firebase login`, o `GOOGLE_APPLICATION_CREDENTIALS` na
   service account na may Firestore Admin role. Huwag i-commit ang key.)
4. Gamitin ang browser config na nasa repo (`src/firebaseConfig.ts`). Huwag
   mag-commit ng service-account JSON o Admin private key.

## Paano i-verify na gumagana (walang UI)

Anonymous Auth (dapat may `idToken`, hindi error):

```bash
curl -s -X POST \
  "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=<WEB_API_KEY>" \
  -H 'Content-Type: application/json' -d '{"returnSecureToken":true}'
```

Firestore (dapat `200`, hindi `404`):

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://firestore.googleapis.com/v1/projects/movies-app-d646b/databases/%28default%29/documents"
```

## Android app

Ang Capacitor Android build ay parehong `src/firebaseConfig.ts` ang ginagamit.
Idagdag ang origin ng WebView (`https://localhost`) sa server CORS
(`ALLOWED_ORIGINS`) — tingnan ang `docs/capacitor-android.md`.
