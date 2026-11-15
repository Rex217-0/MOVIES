# Cloud progress log

What is **verified in this repo**, and what still needs a check in the live
Firebase / Google Cloud Console. No secrets, tokens or private keys here.

## Verified in the repository (static, from code)

| Item | Where | Verified |
| --- | --- | --- |
| Firebase project id | `.firebaserc`, `src/firebaseConfig.ts` | `movies-app-d646b` |
| Anonymous auth + history sync code | `src/firebaseClient.ts` | Present; uses the public Web API key and REST endpoints |
| History rules | `firestore.rules` `users/{uid}/movie_history` | Read/write gated to `request.auth.uid == userId` |
| Factory rules (draft) | `firestore.rules` `MovieJobs` / `SceneJobs` | Read/write gated to the `admin` custom claim |
| Factory local store | `src/direk/factoryDb.ts` (SQLite) | Local only; no browser client writes to Firestore today |
| Drive OAuth (authorization-code, `drive.file` scope) | `src/direk/gdrive.ts` | Present; client id/secret from env only |
| Drive routes | `server.ts` `/api/direk/drive/status|auth|callback` | Present |
| Drive token file | `gdrive.token.json` | Gitignored |
| Secret scan | whole git history | No `GOCSPX`, no private key, no committed secret |

## Not yet verified (needs the live console)

- [ ] Anonymous sign-in enabled in Firebase Authentication.
- [ ] Firestore database created for `movies-app-d646b`.
- [ ] Current `firestore.rules` deployed.
- [ ] Movie Maker history sync works against the live project.
- [ ] `admin` custom claim set; Factory collections usable in live Firestore.
- [ ] Google Drive API enabled on the Cloud project.
- [ ] Authorized redirect URI matches `/api/direk/drive/status` exactly.
- [ ] Consent screen completed for the actual users.
- [ ] One small approved Drive upload succeeds.

## Open items found in this pass

1. **OAuth client secret was exposed in a screenshot.** Treat it as
   compromised: reset/rotate it in Google Cloud Credentials, revoke the old
   client's access, delete any local `gdrive.token.json`, and re-authorize.
   It was never committed to this repo (confirmed across all history).
2. **`firestore.rules` read scope.** `MovieJobs` / `SceneJobs` reads were gated
   only by `signedIn() && org_id == 'LJRgroupORG'`, which any anonymous user
   could satisfy. Reads are now admin-only, matching the write gate.
3. **`server.ts` does not set `trust proxy`.** Behind a TLS proxy `req.protocol`
   can be `http`, so the `redirect_uri` shown by `/api/direk/drive/status` may
   not match the URI registered in Google Cloud. Compare them before deploying;
   set `GDRIVE_REDIRECT_URI` explicitly if they differ.
4. **Missing doc.** `docs/google-drive-oauth-setup.md` is referenced but does
   not exist in the repo or its history.

## How to record a live check

Append a dated line with what was tested, the result, and non-secret evidence
(the status code, the project id, the redirect URI shape). Never paste a secret,
token, or private key.
