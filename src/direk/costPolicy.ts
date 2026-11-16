/**
 * The no-cost policy.
 *
 * Free-first is the law of this app: every output path must run for free, and a
 * paid cloud service may run only when a deployment explicitly opts in. The app
 * never spends money silently.
 *
 * One switch, `ALLOW_PAID_CLOUD`, opens every paid door:
 *   unset / 0   free only (the default). Paid engines are skipped.
 *   1           paid cloud services may run.
 *
 * The local engines are always free and never need the switch: ComfyUI on the
 * Server-2 GPU, the bundled offline Tagalog voice, Piper, ffmpeg, the asset
 * store, and the local Ollama. See docs/no-cost-audit.md for the full list.
 */

/** True when a deployment allows paid cloud services. Defaults to free-only. */
export function paidCloudAllowed(): boolean {
  const raw = (process.env.ALLOW_PAID_CLOUD || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * A paid cloud service is usable only when it is configured *and* the
 * deployment opted in. Both must hold, so a leftover key cannot spend on its
 * own.
 */
export function paidReady(configured: boolean): boolean {
  return configured && paidCloudAllowed();
}

/** The message every paid path shows when it is blocked by the policy. */
export const PAID_BLOCKED_DETAIL =
  'Naka-off ang bayad na cloud (no-cost policy). I-set ang ALLOW_PAID_CLOUD=1 para payagan.';
