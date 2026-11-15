# Google Drive OAuth client setup (MOVIE CREATOR)

This guide prepares the existing Google Drive integration in `src/direk/gdrive.ts`. It does **not** create an OAuth client or authorize an account. A project owner or authorized Google Cloud administrator must perform the Console steps and keep the client secret private.

## What the repository already supports

- Google Drive API v3 upload/list integration with the least-privilege `drive.file` scope.
- Server-side OAuth authorization-code flow and routes:
  - `GET /api/direk/drive/status` — reports readiness and the exact callback URI.
  - `GET /api/direk/drive/auth` — begins Google consent.
  - `GET /api/direk/drive/callback` — receives Google's redirect and saves tokens locally.
- Without Drive OAuth setup, the cloud-storage connector can still return a local ZIP.

## Register the OAuth client when ready

1. Sign in to [Google Cloud Console](https://console.cloud.google.com/) with the account that owns or administers the intended project. Select the existing project intended for this app, or create one only if the owner chooses to separate it. Do not assume the Firebase project is also the correct Google Cloud project without confirming in Console.
2. In **APIs & Services → Library**, enable **Google Drive API** for that project.
3. Configure the OAuth consent / Google Auth Platform settings for the intended audience. Add the app name and support contact. For an external app in testing, add the Google account(s) that will test it. Choose the audience and publishing state that match the actual deployment and users; do not publish or submit for verification without the owner's approval.
4. Create an OAuth client under **Clients / Credentials → Create OAuth client**. Choose **Web application** (the app's server exchanges the authorization code using a client secret).
5. Deploy or run the app at its intended host, then request `GET /api/direk/drive/status` on that same host. Copy the `redirect_uri` value from the JSON response **exactly** into **Authorized redirect URIs** for the OAuth client. It must match scheme, host, port, path, and trailing-slash behavior exactly. The callback path is `/api/direk/drive/callback`.
   - If the app is behind a reverse proxy, confirm the status endpoint reports the public HTTPS host and scheme before registering it. Do not guess the production callback from a local default.
   - For local-only development, use the exact URI reported by the local status endpoint. Register separate local and production callback URIs only if both environments are actually needed.
   - This is a server-side flow; an authorized JavaScript origin is generally not needed for this integration. Do not add broad origins unless the Console specifically requires them for another client feature.
6. Create the client and copy its **Client ID** and **Client secret** into the server's secret manager/environment or the app's protected SETUP panel, using `GDRIVE_CLIENT_ID` and `GDRIVE_CLIENT_SECRET`. Never put the secret in frontend code, a checked-in `.env`, issue comments, screenshots, or chat messages.
7. Check that the generated token file is stored in protected local/server storage and excluded from Git before authorizing. By default the integration writes `gdrive.token.json` in the working directory; `GDRIVE_TOKEN_FILE` can select a protected location. Treat refresh tokens as credentials.
8. Restart/reload configuration if needed. Open the authenticated app's `/api/direk/drive/status` and confirm `configured: true` and the expected `redirect_uri`. Then open `/api/direk/drive/auth`, sign in with an allowed account, and grant consent.
9. Recheck `/api/direk/drive/status` for `authorized: true`, then do a small, approved test upload and confirm the file appears in the intended Drive. Record the date, environment, and evidence in `docs/CLOUD_PROGRESS.md` without recording secrets or personal token data.

## Important caveats

- OAuth setup and live authorization require access to the actual Google Cloud project and a Google account; repository changes cannot perform those Console actions.
- Consent-screen testing/publishing requirements and token behavior depend on the app's audience, configuration, and current Google policies. Check the Console warnings and current Google documentation before relying on long-lived authorization or opening access to additional users.
- `drive.file` is intentionally narrower than full Drive access. Keep it unless a separately reviewed feature genuinely requires another scope.
- A successful setup must be verified live. Configuration files or this checklist alone are not proof that the API is enabled, consent completed, or upload tested.
