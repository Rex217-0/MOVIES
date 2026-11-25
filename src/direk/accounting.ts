/**
 * Operational accounting for every render.
 *
 * The old UI called local GPU work "FREE". It is not free: it burns electricity,
 * wears the card, and blocks the GPU for other work. What is actually true is
 * narrower and more useful — **no vendor billed us for this call**. Saying that
 * precisely is the whole point of this module.
 *
 * Three cost bases, and no fourth guess:
 *
 *   NO_VENDOR_CALL_COST     the work ran on hardware we already own. No vendor
 *                           invoice exists. (ComfyUI on Server-2, ffmpeg, the
 *                           offline Tagalog voice, local Ollama.)
 *   THIRD_PARTY_FREE_TIER   a vendor was called, but on a tier that does not
 *                           bill. It still costs quota, rate limit and
 *                           goodwill. (Pexels, Pollinations, Gemini free tier.)
 *   VENDOR_METERED          a vendor was called and will bill for it.
 *                           (Wan 2.2 on fal.ai when ALLOW_PAID_CLOUD=1.)
 *
 * A metered call whose price we do not know records `cloudCost: null` with
 * `confidence: 'unknown'`. It does not record 0, because 0 is a measurement and
 * we did not measure anything.
 */

/** How a piece of work is paid for. Never a bare "free". */
export type CostBasis =
  | 'NO_VENDOR_CALL_COST'
  | 'THIRD_PARTY_FREE_TIER'
  | 'VENDOR_METERED'
  /** The engine did not say, and we refuse to guess. */
  | 'UNKNOWN';

/** How much to trust `cloudCost`. */
export type CostConfidence = 'measured' | 'estimated' | 'none' | 'unknown';

/** A money amount, or an honest statement that we do not have one. */
export interface CloudCost {
  /** Null means "not known", which is different from zero. */
  amount: number | null;
  currency: 'USD';
  confidence: CostConfidence;
}

/**
 * Everything the operator needs to answer "what did this job cost us, and why".
 * One of these per scene, rolled up into one per film.
 */
export interface JobAccounting {
  /** Wall-clock milliseconds spent inside the renderer for this unit of work. */
  renderDurationMs: number;
  /**
   * How many times this scene had to be attempted again. A first attempt is 0,
   * so "retry_count" means exactly what it says.
   */
  retryCount: number;
  /** Bytes this job left on disk (assets plus served renders). */
  storageBytes: number;
  /**
   * Outbound calls to a third-party API. Loopback calls to a local ComfyUI are
   * NOT counted: they never leave the machine and no vendor sees them.
   */
  externalApiCalls: number;
  /** What the vendors billed, or null when we do not know. */
  cloudCost: CloudCost;
  /** The dominant cost basis for this unit of work. */
  costBasis: CostBasis;
  /** Which engines contributed, so the basis can be audited. */
  engines: string[];
}

/** The label the UI shows instead of the old, misleading "FREE". */
export const COST_BASIS_LABEL: Record<CostBasis, string> = {
  NO_VENDOR_CALL_COST: 'NO VENDOR CALL COST',
  THIRD_PARTY_FREE_TIER: 'THIRD-PARTY FREE TIER',
  VENDOR_METERED: 'VENDOR METERED',
  UNKNOWN: 'COST UNKNOWN',
};

/** A one-line explanation for each basis, so the label is never bare. */
export const COST_BASIS_NOTE: Record<CostBasis, string> = {
  NO_VENDOR_CALL_COST: 'Tumakbo sa hardware natin; walang vendor na siningil.',
  THIRD_PARTY_FREE_TIER: 'May vendor na tinawag, pero sa libreng tier — quota ang gastos, hindi pera.',
  VENDOR_METERED: 'May vendor na maniningil para sa tawag na ito.',
  UNKNOWN: 'Hindi sinabi ng engine kung paano ito binayaran.',
};

/**
 * The cost basis of one engine.
 *
 * `stock` is a third-party free tier because Pexels/Pixabay are called over the
 * network. `wan` is metered because fal.ai bills per second of generated video.
 * Everything else in this app is local hardware.
 */
export function costBasisForEngine(engine: string): CostBasis {
  const key = (engine || '').trim().toLowerCase();
  if (key === 'comfyui' || key === 'motion' || key === 'ffmpeg' || key === 'local' || key === 'ollama') {
    return 'NO_VENDOR_CALL_COST';
  }
  if (key === 'stock' || key === 'pexels' || key === 'pixabay' || key === 'pollinations') {
    return 'THIRD_PARTY_FREE_TIER';
  }
  if (key === 'wan' || key === 'fal' || key === 'opencut' || key === 'fish') {
    return 'VENDOR_METERED';
  }
  return 'UNKNOWN';
}

/** A zeroed accounting record, for a scene that has not run yet. */
export function emptyAccounting(): JobAccounting {
  return {
    renderDurationMs: 0,
    retryCount: 0,
    storageBytes: 0,
    externalApiCalls: 0,
    cloudCost: { amount: 0, currency: 'USD', confidence: 'none' },
    costBasis: 'NO_VENDOR_CALL_COST',
    engines: [],
  };
}

/** An unknown price, stated as unknown rather than as zero. */
export function unknownCost(): CloudCost {
  return { amount: null, currency: 'USD', confidence: 'unknown' };
}

/**
 * Roll several cost bases up into the one that describes the batch.
 *
 * The most expensive basis wins, because a film that made one metered call is
 * not "no vendor call cost" — the invoice exists. `UNKNOWN` outranks
 * `VENDOR_METERED` only when nothing better is known, since an unknown engine
 * could be anything.
 */
export function dominantCostBasis(bases: CostBasis[]): CostBasis {
  const rank: Record<CostBasis, number> = {
    NO_VENDOR_CALL_COST: 0,
    THIRD_PARTY_FREE_TIER: 1,
    UNKNOWN: 2,
    VENDOR_METERED: 3,
  };
  let best: CostBasis = 'NO_VENDOR_CALL_COST';
  for (const b of bases) {
    if (rank[b] > rank[best]) best = b;
  }
  return best;
}

/**
 * Add one engine's cost into a running total.
 *
 * Money adds only when both sides know the amount. One unknown amount poisons
 * the sum to `null` rather than silently under-reporting it, which is the
 * failure mode that makes a cost report worse than none.
 */
export function addCost(a: CloudCost, b: CloudCost): CloudCost {
  if (a.confidence === 'unknown' || b.confidence === 'unknown') return unknownCost();
  const amount = (a.amount ?? 0) + (b.amount ?? 0);
  const confidence: CostConfidence =
    a.confidence === 'measured' && b.confidence === 'measured' ? 'measured'
      : a.confidence === 'none' && b.confidence === 'none' ? 'none'
        : 'estimated';
  return { amount, currency: 'USD', confidence };
}

/** Sum a list of accounting records into the job-level total. */
export function sumAccounting(parts: JobAccounting[]): JobAccounting {
  const total = emptyAccounting();
  const engines = new Set<string>();
  for (const p of parts) {
    total.renderDurationMs += p.renderDurationMs;
    total.retryCount += p.retryCount;
    total.storageBytes += p.storageBytes;
    total.externalApiCalls += p.externalApiCalls;
    total.cloudCost = addCost(total.cloudCost, p.cloudCost);
    for (const e of p.engines) engines.add(e);
  }
  total.engines = [...engines];
  total.costBasis = dominantCostBasis(parts.map(p => p.costBasis));
  return total;
}

/**
 * The optional price of metered video, in USD per second of generated footage.
 *
 * Unset means "we do not know the price", and the job records `null` rather than
 * a made-up figure. Set it and the cost becomes an estimate that is labelled as
 * an estimate.
 */
export function meteredVideoUsdPerSecond(): number | null {
  const raw = (process.env.FAL_USD_PER_SECOND || '').trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** The cost of a metered render, priced only when a rate is configured. */
export function meteredCost(engine: string, seconds: number): CloudCost {
  if (costBasisForEngine(engine) !== 'VENDOR_METERED') {
    return { amount: 0, currency: 'USD', confidence: 'none' };
  }
  const rate = meteredVideoUsdPerSecond();
  if (rate === null) return unknownCost();
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  return { amount: Number((rate * safeSeconds).toFixed(4)), currency: 'USD', confidence: 'estimated' };
}

/**
 * Build one scene's accounting from what the renderer reported.
 *
 * The renderer knows which engines it touched and how many third-party calls it
 * made; this function only classifies and adds. It never invents a call count,
 * so an engine that reports nothing records zero external calls rather than a
 * plausible-looking number.
 */
export function sceneAccounting(input: {
  engine: string;
  seconds: number;
  durationMs: number;
  storageBytes?: number;
  externalApiCalls?: number;
  retryCount?: number;
}): JobAccounting {
  // A scene is several shots, so its backend is a `+`-joined list
  // ("comfyui+wan"). Splitting keeps each engine classified on its own; reading
  // the joined string as one name would classify a mixed scene as UNKNOWN and
  // under-report the metered half.
  const engines = input.engine
    .split('+')
    .map(e => e.trim())
    .filter(Boolean);
  const bases = engines.map(costBasisForEngine);
  return {
    renderDurationMs: Math.max(0, Math.round(input.durationMs)),
    retryCount: Math.max(0, input.retryCount ?? 0),
    storageBytes: Math.max(0, input.storageBytes ?? 0),
    externalApiCalls: Math.max(0, input.externalApiCalls ?? 0),
    cloudCost: meteredCostForEngines(engines, input.seconds),
    costBasis: bases.length ? dominantCostBasis(bases) : 'UNKNOWN',
    engines,
  };
}

/** The metered price of a multi-engine scene: the sum of its metered engines. */
function meteredCostForEngines(engines: string[], seconds: number): CloudCost {
  const metered = engines.filter(e => costBasisForEngine(e) === 'VENDOR_METERED');
  if (!metered.length) return { amount: 0, currency: 'USD', confidence: 'none' };
  let total: CloudCost = { amount: 0, currency: 'USD', confidence: 'none' };
  for (const engine of metered) total = addCost(total, meteredCost(engine, seconds));
  return total;
}
