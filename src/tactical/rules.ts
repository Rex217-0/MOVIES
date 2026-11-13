/**
 * Tactical decision rules and directive hazard parsing for Pilot's Battle Room.
 */

export interface HazardEvaluation {
  isHazardous: boolean;
  actionCode: string;
  reason: string;
}

const HAZARD_KEYWORDS = [
  { match: /strike|kinetic|bombard|torpedo|fire weapon/i, code: 'AUTHORIZE_KINETIC_STRIKE', reason: 'High-yield kinetic bombardment requires confirmation' },
  { match: /override|safemed override|bypass safety/i, code: 'PROTOCOL_SAFETY_OVERRIDE', reason: 'Disabling safety locks requires explicit confirmation' },
  { match: /destruct|purge|self-destruct|wipe/i, code: 'SYSTEM_PURGE_SEQUENCE', reason: 'Destructive system wipe requires authorization' },
  { match: /scramble|emp|full power discharge/i, code: 'HIGH_ENERGY_EMP_DISCHARGE', reason: 'Grid disruption weapon system requires confirmation' },
];

/**
 * Checks if a commander directive contains lethal, hazardous, or system-altering actions
 * that mandate affirmative confirmation.
 */
export function evaluateDirectiveHazard(directive: string, confirmed = false): HazardEvaluation {
  if (confirmed) {
    return { isHazardous: false, actionCode: 'CONFIRMED', reason: 'User confirmed action' };
  }

  const clean = (directive || '').trim();
  for (const item of HAZARD_KEYWORDS) {
    if (item.match.test(clean)) {
      return {
        isHazardous: true,
        actionCode: item.code,
        reason: item.reason,
      };
    }
  }

  return {
    isHazardous: false,
    actionCode: 'STANDARD_EXECUTION',
    reason: 'Standard directive',
  };
}

/**
 * Calculates current neural telemetry vitals based on execution latency and token metrics.
 */
export function calculateVitals(
  elapsedMs: number,
  tokenCount: number,
  baseLatencyMs = 28
): { latency_ms: number; tokens_per_sec: number } {
  const latency = Math.max(12, Math.round(elapsedMs > 0 ? elapsedMs : baseLatencyMs));
  const effectiveSec = Math.max(0.1, latency / 1000);
  const tps = Number((tokenCount / effectiveSec).toFixed(1));

  return {
    latency_ms: latency,
    tokens_per_sec: Math.max(18.5, Math.min(120, tps || 45.2)),
  };
}

/**
 * Safely parses JSON or extracts tactical directives from model response.
 */
export function parsePilotResponse(raw: string, fallbackIntent = 'TACTICAL_SYNTHESIS'): {
  status: 'success' | 'queued' | 'requires_confirmation';
  intent: string;
  action: string;
  analysis: string;
} {
  if (!raw) {
    return {
      status: 'success',
      intent: fallbackIntent,
      action: 'DIRECTIVE_EXECUTED',
      analysis: 'Direct neural link confirmed directive.',
    };
  }

  try {
    // Attempt direct parse or markdown json block extraction
    let text = raw.trim();
    if (text.startsWith('```json')) {
      text = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (text.startsWith('```')) {
      text = text.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    const parsed = JSON.parse(text);
    return {
      status: 'success',
      intent: (parsed.intent || fallbackIntent).toUpperCase().replace(/\s+/g, '_'),
      action: parsed.action || 'DIRECTIVE_EXECUTED',
      analysis: parsed.analysis || parsed.summary || text.slice(0, 180),
    };
  } catch {
    // Graceful string extraction
    return {
      status: 'success',
      intent: fallbackIntent,
      action: 'TACTICAL_DIRECTIVE_PROCESSED',
      analysis: raw.slice(0, 240),
    };
  }
}

/**
 * Validates aspect ratio for gemini-omni-1.2-flash video generation.
 * Must be strictly '16:9' (landscape) or '9:16' (portrait).
 */
export function validateVideoAspectRatio(input?: string): '16:9' | '9:16' {
  if (input === '9:16') return '9:16';
  return '16:9';
}

/**
 * Validates inputs for gemini-nano-banana-2.1 image editing.
 */
export function validateImageEditInput(imageBase64?: string, prompt?: string): { valid: boolean; error?: string } {
  if (!prompt || !prompt.trim()) {
    return { valid: false, error: 'Edit prompt is required.' };
  }
  if (!imageBase64 || !imageBase64.trim()) {
    return { valid: false, error: 'Source image data is required.' };
  }
  return { valid: true };
}

/**
 * Formats a tactical prompt for reconnaissance video generation.
 */
export function buildTacticalVideoPrompt(rawPrompt: string, styleModifier = 'cinematic tactical HUD'): string {
  const clean = rawPrompt.trim();
  if (clean.toLowerCase().includes('tactical') || clean.toLowerCase().includes('cinematic')) {
    return clean;
  }
  return `${clean}, ${styleModifier}, high-fidelity sci-fi reconnaissance simulation`;
}

export interface VideoAsset {
  id: string;
  title: string;
  url: string;
  status: 'rendering' | 'completed' | 'failed';
  reviewStatus: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

/**
 * Updates reviewStatus for an asset in the RenderVault.
 */
export function applyAssetReview(
  assets: VideoAsset[],
  assetId: string,
  action: 'approve' | 'reject'
): VideoAsset[] {
  return assets.map((asset) => {
    if (asset.id === assetId) {
      return {
        ...asset,
        reviewStatus: action === 'approve' ? 'approved' : 'rejected',
      };
    }
    return asset;
  });
}


