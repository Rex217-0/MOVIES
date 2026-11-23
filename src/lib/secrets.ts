/**
 * Secret scrubbing shared by the AI transports.
 *
 * This lives in its own module so `ai.ts` and `aiRouter.ts` can both use it
 * without importing each other: `ai.ts` is a transport, `aiRouter.ts` is the
 * chain that picks a transport, and a direct import between them would cycle.
 *
 * Two passes run. First every configured secret is removed by exact match.
 * Then known key shapes are removed by pattern, because a provider can echo a
 * key back in an error body that was never in our own environment.
 */

/** Env vars whose values must never appear in a message we log or return. */
const SECRET_ENV_NAMES = [
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_API_KEY',
  'APP_AUTH_TOKEN',
  'KAGGLE_PILOT_TOKEN',
  'CF_API_TOKEN',
  'CF_ACCOUNT_ID',
  'AI_GATEWAY_ID',
  'FIREBASE_SERVICE_ACCOUNT',
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_CLIENT_EMAIL',
] as const;

function secretValues(): string[] {
  return SECRET_ENV_NAMES.map((name) => process.env[name])
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 4);
}

/**
 * Strip secrets from an error message.
 *
 * `CF_API_TOKEN` is in the env list above, so a Cloudflare error body that
 * echoes the token is redacted by exact match. Cloudflare tokens are also
 * matched by shape, since a token can appear in a body we never set.
 */
export function sanitizeError(err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err);
  for (const secret of secretValues()) {
    msg = msg.split(secret).join('[REDACTED]');
  }
  return msg
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]')
    .replace(/sk-ant-[0-9A-Za-z_-]{10,}/g, '[REDACTED]')
    .replace(/\bsk-[0-9A-Za-z]{20,}/g, '[REDACTED]')
    // Cloudflare API tokens are 40 chars of base64url. `{40,}` also catches a
    // token glued to punctuation in an error body. Over-redacting a long opaque
    // run in a log line is the safe direction to be wrong in.
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[REDACTED]')
    .replace(/([?&](?:key|api_key|access_token)=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[0-9A-Za-z._-]{10,}/gi, '$1[REDACTED]')
    // A private key block must never survive into a log.
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]');
}
