import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { 
  evaluateDirectiveHazard, 
  calculateVitals, 
  parsePilotResponse,
  validateVideoAspectRatio,
  validateImageEditInput,
  buildTacticalVideoPrompt,
  applyAssetReview,
  type VideoAsset
} from './src/tactical/rules.ts';
import {
  IMAGE_MODEL,
  IMAGE_MODEL_FREE,
  TEXT_MODEL,
  VIDEO_MODEL,
  VIDEO_MODEL_FREE,
  aiUnavailable,
  NO_FREE_IMAGE_MODEL,
  NO_FREE_VIDEO_MODEL,
} from './src/config.ts';
import { ReferenceCatalog } from './src/direk/reference.ts';
import { MarketIntel } from './src/direk/market.ts';
import { DirekService, type ChatMessage } from './src/direk/service.ts';
import { PIPELINE, STAGE_SKILL } from './src/direk/pipeline.ts';
import { GENRE_MAP } from './src/direk/genres.ts';
import { SKILLS } from './src/direk/skills.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProd = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

const app = express();
// Allow large base64 image uploads for image editing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ---------------------------------------------------------------------------
// Authentication
// Every /api route is protected by a bearer token. Auth is fail-closed in
// production: if APP_AUTH_TOKEN is not set there, the server refuses to start
// rather than exposing unauthenticated (and billable) AI endpoints.
// EventSource cannot set headers, so the SSE route additionally accepts the
// token via a `?token=` query parameter.
// ---------------------------------------------------------------------------
const AUTH_TOKEN = process.env.APP_AUTH_TOKEN;
const authRequired = isProd || Boolean(AUTH_TOKEN);

if (isProd && !AUTH_TOKEN) {
  console.error('APP_AUTH_TOKEN must be set when NODE_ENV=production. Refusing to start.');
  process.exit(1);
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!authRequired) {
    next();
    return;
  }
  const header = req.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
  if (AUTH_TOKEN && (bearer === AUTH_TOKEN || queryToken === AUTH_TOKEN)) {
    next();
    return;
  }
  res.status(401).json({
    error:
      'Unauthorized. Send a valid bearer token in the Authorization header ' +
      '(or ?token= for the thought stream).',
  });
}

app.use('/api', requireAuth);

// Initialize GoogleGenAI server-side with telemetry header
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

// Tactical state
let currentVitals = {
  latency_ms: 0,
  tokens_per_sec: 0,
  model: TEXT_MODEL,
  status: 'IDLE',
  memory_load_pct: 28,
  shield_pct: 94,
  hull_pct: 100,
  tactical_grid_status: 'NOMINAL',
};

let activeProtocols = [
  { id: 'A24_CINEMATOGRAPHY', name: 'A24 Cinematography', active: true, desc: 'Dynamic dramatic atmospheric color grading & HUD camera fidelity' },
  { id: 'MOCCASIN_CONSISTENCY', name: 'Moccasin Consistency', active: true, desc: 'Stealth footing telemetry & non-linear trajectory tracking' },
  { id: 'SAFEMED_COMPLIANCE', name: 'SafeMed Compliance', active: true, desc: 'Biological pilot life-support safety & anti-g-force locks' },
  { id: 'GEMINI_TEXT_REASONING', name: 'Gemini Text Reasoning', active: true, desc: `Text directives are answered by ${TEXT_MODEL}` },
];

const directiveHistory: Array<{
  id: string;
  timestamp: string;
  directive: string;
  intent: string;
  action: string;
  analysis: string;
  latency_ms: number;
}> = [];

interface MediaItem {
  id: string;
  type: 'video' | 'image' | 'edited-image';
  url: string;
  prompt: string;
  aspect_ratio: string;
  timestamp: string;
  model: string;
  sourceImageUrl?: string;
  details?: string;
}

// Media gallery
const mediaGallery: MediaItem[] = [
  {
    id: 'VID-PRESET-1',
    type: 'video',
    url: '', // dynamic or fallback
    prompt: 'Orbital dreadnought entering hyperspace above Europa with ion particle wake',
    aspect_ratio: '16:9',
    timestamp: 'Initial Recon',
    model: 'placeholder',
    details: 'Sample clip shipped with the project - not AI generated',
  },
  {
    id: 'IMG-PRESET-1',
    type: 'image',
    url: '',
    prompt: 'Tactical holographic wireframe of deep-space combat cruiser with cybernetic HUD reticles',
    aspect_ratio: '1:1',
    timestamp: 'Initial Recon',
    model: 'placeholder',
    details: 'Placeholder illustration - not AI generated',
  }
];

// Video Asset Vault (Staging & Cinestream review)
let renderVaultAssets: VideoAsset[] = [
  {
    id: 'ASSET-SERVER2-01',
    title: 'Cinematic Hyperdrive Vector · Europa Orbit',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    status: 'completed',
    reviewStatus: 'pending',
    createdAt: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
  },
  {
    id: 'ASSET-SERVER2-02',
    title: 'Autonomous Drone Volcanic Canyon Recon',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    status: 'completed',
    reviewStatus: 'pending',
    createdAt: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
  },
  {
    id: 'ASSET-SERVER2-03',
    title: 'Aegis Dreadnought Orbital Shield Flare [LIVE]',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    status: 'completed',
    reviewStatus: 'approved',
    createdAt: new Date(Date.now() - 1000 * 60 * 180).toISOString(),
  },
];
/**
 * Extracts the first inline image returned by an Interactions API call.
 * Returns null when the response contains no image, so callers can fail loudly
 * instead of substituting a placeholder.
 */
function extractImageFromInteraction(interaction: any): string | null {
  if (interaction?.output_image?.data) {
    const mime = interaction.output_image.mime_type || 'image/png';
    return `data:${mime};base64,${interaction.output_image.data}`;
  }
  for (const step of interaction?.steps || []) {
    if (step?.type === 'model_output') {
      const imageContent = step.content?.find((c: any) => c.type === 'image');
      if (imageContent?.data) {
        const mime = imageContent.mime_type || 'image/png';
        return `data:${mime};base64,${imageContent.data}`;
      }
    }
  }
  return null;
}

// SSE Clients for Thought Stream
const sseClients = new Set<Response>();

function broadcastThought(thoughtText: string) {
  for (const client of sseClients) {
    try {
      client.write(`data: ${thoughtText}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Background ambient tactical thought generator
const AMBIENT_PILOT_THOUGHTS = [
  'Sensory sweep complete. Outer perimeter clear of gravimetric anomalies.',
  'Recalibrating ion manifolds for instantaneous vector deflection.',
  'SafeMed life-support monitoring pilot neural pulse: 72 BPM, optimal cognitive state.',
  'Carbon high-thinking matrix standby: reasoning buffer at 99.8% readiness.',
  'Telemetry synchronized with orbital relays. Moccasin signature suppressed.',
  'A24 optical filters adjusted for high-contrast deep-space luminescence.',
  'Targeting radar array passive scan: 0 hostile locks detected in current quadrant.',
];

let ambientIndex = 0;
setInterval(() => {
  if (sseClients.size > 0) {
    const thought = AMBIENT_PILOT_THOUGHTS[ambientIndex % AMBIENT_PILOT_THOUGHTS.length];
    ambientIndex++;
    broadcastThought(thought);
  }
}, 8000);

// 1. Vitals Endpoint
app.get('/api/pilot/status', (_req: Request, res: Response) => {
  res.json({
    latency_ms: currentVitals.latency_ms,
    tokens_per_sec: currentVitals.tokens_per_sec,
    model: currentVitals.model,
    status: currentVitals.status,
    memory_load_pct: currentVitals.memory_load_pct,
    shield_pct: currentVitals.shield_pct,
    hull_pct: currentVitals.hull_pct,
    active_protocols: activeProtocols.filter(p => p.active).map(p => p.id),
  });
});

// 1b. Health / capability report. States plainly which features are real and
// which are unavailable, so the UI never has to guess.
app.get('/api/health', (_req: Request, res: Response) => {
  const keyConfigured = Boolean(process.env.GEMINI_API_KEY);
  res.json({
    ok: keyConfigured,
    gemini_key_configured: keyConfigured,
    text: { model: TEXT_MODEL, available: keyConfigured, free_tier: true },
    direk: {
      available: keyConfigured,
      free_tier: true,
      model: TEXT_MODEL,
      reference_available: referenceCatalog.available,
      reference_rows: referenceCatalog.size,
    },
    image: {
      model: IMAGE_MODEL,
      available: keyConfigured && IMAGE_MODEL_FREE,
      free_tier: IMAGE_MODEL_FREE,
      reason: IMAGE_MODEL_FREE ? null : NO_FREE_IMAGE_MODEL,
    },
    video: {
      model: VIDEO_MODEL,
      available: keyConfigured && VIDEO_MODEL_FREE,
      free_tier: VIDEO_MODEL_FREE,
      reason: VIDEO_MODEL_FREE ? null : NO_FREE_VIDEO_MODEL,
    },
  });
});

// 2. Thought Stream (SSE)
app.get('/api/pilot/thought-stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Send initial handshake thought
  res.write(`data: Pilot cognitive link established. Text model: ${TEXT_MODEL}.\n\n`);
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// 3. Command Execution
app.post('/api/pilot/command', async (req: Request, res: Response) => {
  const { directive, confirmed } = req.body;

  if (!directive || typeof directive !== 'string' || !directive.trim()) {
    res.status(400).json({ error: 'Directive is required.' });
    return;
  }

  const cleanDirective = directive.trim();
  const startTime = Date.now();

  // Check safety hazard gates
  const hazard = evaluateDirectiveHazard(cleanDirective, !!confirmed);
  if (hazard.isHazardous) {
    broadcastThought(`[SAFETY INTERCEPT] Directive flagged: ${hazard.reason}. Awaiting affirmative confirmation.`);
    res.json({
      status: 'requires_confirmation',
      action: hazard.actionCode,
      reason: hazard.reason,
    });
    return;
  }

  // Broadcast cognitive initialization
  broadcastThought(`[COGNITIVE LINK] Directive received: "${cleanDirective}"`);

  // Honest behaviour: if no usable model is available, say so. We never
  // fabricate a tactical "analysis" and present it as a model response.
  if (!process.env.GEMINI_API_KEY) {
    broadcastThought('[SYS] No GEMINI_API_KEY configured - directive not executed.');
    res.status(503).json(
      aiUnavailable(
        TEXT_MODEL,
        'Set GEMINI_API_KEY (free tier) to enable directive execution.',
        'The Gemini API key is not configured'
      )
    );
    return;
  }

  broadcastThought(`[TEXT REASONING] Calling ${TEXT_MODEL}...`);

  try {
    const response = await ai.models.generateContent({
      model: TEXT_MODEL,
      contents: `Commander Directive: "${cleanDirective}"
Analyze and execute this tactical command for the VIP Battle Room.
Respond in strict JSON with:
{
  "intent": "SHORT_UPPERCASE_INTENT",
  "action": "Specific tactical action executed",
  "analysis": "Tactical assessment and reasoning (2-3 sentences)",
  "readiness": "OPTIMAL"
}`,
      config: {
        systemInstruction: "You are the elite AI Pilot Tactical Core in a military sci-fi battle room. Execute directives with analytical rigor.",
        responseMimeType: "application/json",
      },
    });

    const rawText = response.text || '';
    const parsed = parsePilotResponse(rawText, 'TACTICAL_SYNTHESIS');
    const resultIntent = parsed.intent;
    const resultAction = parsed.action;
    const resultAnalysis = parsed.analysis;
    const tokenEst = (rawText.length / 4) + 80;

    const elapsedMs = Math.max(18, Date.now() - startTime);
    const calculated = calculateVitals(elapsedMs, tokenEst);
    currentVitals = {
      ...currentVitals,
      latency_ms: calculated.latency_ms,
      tokens_per_sec: calculated.tokens_per_sec,
      status: 'ONLINE',
      model: TEXT_MODEL,
    };

    broadcastThought(`[SYNTHESIS COMPLETE] Intent: ${resultIntent} | ${resultAnalysis}`);

    const record = {
      id: `DIR-${Date.now()}`,
      timestamp: new Date().toLocaleTimeString(),
      directive: cleanDirective,
      intent: resultIntent,
      action: resultAction,
      analysis: resultAnalysis,
      latency_ms: calculated.latency_ms,
    };
    directiveHistory.unshift(record);
    if (directiveHistory.length > 50) directiveHistory.pop();

    res.json({
      status: 'success',
      model: TEXT_MODEL,
      intent: resultIntent,
      action: resultAction,
      analysis: resultAnalysis,
      latency_ms: calculated.latency_ms,
      tokens_per_sec: calculated.tokens_per_sec,
    });
  } catch (error: any) {
    const reason = error?.message || 'Unknown error';
    console.error(`[SYS ERROR] ${TEXT_MODEL} directive execution failed:`, reason);
    currentVitals = { ...currentVitals, status: 'DEGRADED' };
    broadcastThought(`[SYS ERROR] Directive execution failed: ${reason}`);
    res.status(503).json(
      aiUnavailable(TEXT_MODEL, 'Check the server logs and the Gemini API key.', reason)
    );
  }
});

// ==========================================
// FEATURE: Video Generation
// ==========================================
app.post('/api/pilot/video/generate', async (req: Request, res: Response) => {
  const { prompt, aspect_ratio, duration, resolution } = req.body;

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ error: 'Video prompt is required.' });
    return;
  }

  // Aspect ratio MUST be '16:9' or '9:16'
  const validAspect = validateVideoAspectRatio(aspect_ratio);
  const formattedPrompt = buildTacticalVideoPrompt(prompt);
  const startTime = Date.now();

  broadcastThought(`[VIDEO PIPELINE] Video request for: "${prompt.slice(0, 50)}..." [Aspect: ${validAspect}]`);

  // Honest behaviour: there is no video model on the Gemini free tier, so
  // report the feature as unavailable instead of returning a stock clip that
  // looks like a generated result.
  if (!process.env.GEMINI_API_KEY || !VIDEO_MODEL_FREE) {
    broadcastThought(`[VIDEO UNAVAILABLE] ${NO_FREE_VIDEO_MODEL}`);
    res.status(503).json(
      aiUnavailable(
        VIDEO_MODEL,
        NO_FREE_VIDEO_MODEL,
        'Video generation is unavailable'
      )
    );
    return;
  }

  broadcastThought(`[VIDEO PIPELINE] Calling ${VIDEO_MODEL} via Interactions API...`);

  try {
    const interaction = await ai.interactions.create({
      model: VIDEO_MODEL,
      input: formattedPrompt,
      background: false,
      store: false,
      stream: false,
      response_format: {
        type: 'video',
        aspect_ratio: validAspect, // Strictly '16:9' or '9:16'
        duration: duration || '10s',
        resolution: resolution || '720p',
      },
    }, { timeout: 300000 });

    let videoUrl = '';
    const videoPart = interaction.output_video;
    if (videoPart) {
      if (videoPart.data) {
        const mime = videoPart.mime_type || 'video/mp4';
        videoUrl = `data:${mime};base64,${videoPart.data}`;
      } else if (videoPart.uri) {
        videoUrl = videoPart.uri;
      }
    }

    if (!videoUrl) {
      throw new Error('The model did not return video data');
    }

    const elapsedMs = Date.now() - startTime;
    broadcastThought(`[VIDEO SYNTHESIS COMPLETE] Visual reconnaissance ready (${validAspect}, ${elapsedMs}ms).`);

    const mediaRecord: MediaItem = {
      id: `VID-${Date.now()}`,
      type: 'video',
      url: videoUrl,
      prompt: cleanPrompt(prompt),
      aspect_ratio: validAspect,
      timestamp: new Date().toLocaleTimeString(),
      model: VIDEO_MODEL,
      details: `Resolution: ${resolution || '720p'} · Duration: ${duration || '10s'} · Aspect: ${validAspect}`,
    };

    mediaGallery.unshift(mediaRecord);
    if (mediaGallery.length > 40) mediaGallery.pop();

    // Also sync into RenderVault (Staging review)
    renderVaultAssets.unshift({
      id: `ASSET-${Date.now()}`,
      title: cleanPrompt(prompt),
      url: videoUrl,
      status: 'completed',
      reviewStatus: 'pending',
      createdAt: new Date().toISOString(),
    });

    res.json({
      status: 'success',
      item: mediaRecord,
      latency_ms: elapsedMs,
    });
  } catch (error: any) {
    const reason = error?.message || 'Unknown error';
    console.error(`[VIDEO ERROR] ${VIDEO_MODEL} generation failed:`, reason);
    broadcastThought(`[VIDEO ERROR] Generation failed: ${reason}`);
    res.status(503).json(
      aiUnavailable(VIDEO_MODEL, 'Check the server logs and the Gemini API key.', reason)
    );
  }
});

// ==========================================
// ==========================================
// FEATURE: Create & Edit Images
// ==========================================
app.post('/api/pilot/image/generate', async (req: Request, res: Response) => {
  const { prompt, aspect_ratio, image_size } = req.body;

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ error: 'Image prompt is required.' });
    return;
  }

  const validAspect = aspect_ratio || '1:1';
  const startTime = Date.now();

  broadcastThought(`[IMAGE PIPELINE] Image request: "${prompt.slice(0, 45)}..."`);

  // Honest behaviour: no image model on the Gemini free tier, so report the
  // feature as unavailable instead of returning a generated-looking SVG.
  if (!process.env.GEMINI_API_KEY || !IMAGE_MODEL_FREE) {
    broadcastThought(`[IMAGE UNAVAILABLE] ${NO_FREE_IMAGE_MODEL}`);
    res.status(503).json(
      aiUnavailable(IMAGE_MODEL, NO_FREE_IMAGE_MODEL, 'Image generation is unavailable')
    );
    return;
  }

  try {
    const interaction = await ai.interactions.create({
      model: IMAGE_MODEL,
      input: prompt,
      response_modalities: ['image', 'text'],
      generation_config: {
        image_config: {
          aspect_ratio: validAspect,
          image_size: image_size || '1K',
        },
      },
    });

    const imageUrl = extractImageFromInteraction(interaction);
    if (!imageUrl) {
      throw new Error('The model did not return image data');
    }

    const elapsedMs = Date.now() - startTime;
    broadcastThought(`[IMAGE COMPLETE] Tactical image asset synthesized via ${IMAGE_MODEL} (${elapsedMs}ms).`);

    const mediaRecord: MediaItem = {
      id: `IMG-${Date.now()}`,
      type: 'image',
      url: imageUrl,
      prompt: cleanPrompt(prompt),
      aspect_ratio: validAspect,
      timestamp: new Date().toLocaleTimeString(),
      model: IMAGE_MODEL,
      details: `Resolution: ${image_size || '1K'} · Aspect: ${validAspect}`,
    };

    mediaGallery.unshift(mediaRecord);
    if (mediaGallery.length > 40) mediaGallery.pop();

    res.json({ status: 'success', item: mediaRecord, latency_ms: elapsedMs });
  } catch (error: any) {
    const reason = error?.message || 'Unknown error';
    console.error(`[IMAGE ERROR] ${IMAGE_MODEL} generation failed:`, reason);
    broadcastThought(`[IMAGE ERROR] Generation failed: ${reason}`);
    res.status(503).json(
      aiUnavailable(IMAGE_MODEL, 'Check the server logs and the Gemini API key.', reason)
    );
  }
});

// Edit existing image
app.post('/api/pilot/image/edit', async (req: Request, res: Response) => {
  const { prompt, imageBase64, mimeType } = req.body;

  const validation = validateImageEditInput(imageBase64, prompt);
  if (!validation.valid) {
    res.status(400).json({ error: validation.error });
    return;
  }

  const startTime = Date.now();
  broadcastThought(`[IMAGE EDIT] Image modification request: "${prompt.slice(0, 45)}..."`);

  if (!process.env.GEMINI_API_KEY || !IMAGE_MODEL_FREE) {
    broadcastThought(`[IMAGE UNAVAILABLE] ${NO_FREE_IMAGE_MODEL}`);
    res.status(503).json(
      aiUnavailable(IMAGE_MODEL, NO_FREE_IMAGE_MODEL, 'Image editing is unavailable')
    );
    return;
  }

  try {
    const cleanBase64 = imageBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');

    const interaction = await ai.interactions.create({
      model: IMAGE_MODEL,
      input: [
        { type: 'image', data: cleanBase64, mime_type: mimeType || 'image/png' },
        { type: 'text', text: prompt },
      ],
      response_modalities: ['image', 'text'],
    });

    const editedImageUrl = extractImageFromInteraction(interaction);
    if (!editedImageUrl) {
      throw new Error('The model did not return image data');
    }

    const elapsedMs = Date.now() - startTime;
    broadcastThought(`[IMAGE EDIT COMPLETE] Modification applied via ${IMAGE_MODEL} (${elapsedMs}ms).`);

    const mediaRecord: MediaItem = {
      id: `EDIT-${Date.now()}`,
      type: 'edited-image',
      url: editedImageUrl,
      sourceImageUrl: imageBase64,
      prompt: cleanPrompt(prompt),
      aspect_ratio: '1:1',
      timestamp: new Date().toLocaleTimeString(),
      model: IMAGE_MODEL,
      details: `Edited with ${IMAGE_MODEL}`,
    };

    mediaGallery.unshift(mediaRecord);
    if (mediaGallery.length > 40) mediaGallery.pop();

    res.json({ status: 'success', item: mediaRecord, latency_ms: elapsedMs });
  } catch (error: any) {
    const reason = error?.message || 'Unknown error';
    console.error(`[IMAGE EDIT ERROR] ${IMAGE_MODEL} edit failed:`, reason);
    broadcastThought(`[IMAGE EDIT ERROR] Modification failed: ${reason}`);
    res.status(503).json(
      aiUnavailable(IMAGE_MODEL, 'Check the server logs and the Gemini API key.', reason)
    );
  }
});

// 4. Media Gallery
app.get('/api/pilot/media/gallery', (_req: Request, res: Response) => {
  // Only items that were really produced by a model have a url. Preset items
  // without a url stay without one; the UI renders them as unavailable rather
  // than showing a placeholder that looks AI generated.
  res.json({ items: mediaGallery });
});

// 5. Protocols Management
app.get('/api/pilot/protocols', (_req: Request, res: Response) => {
  res.json({ protocols: activeProtocols });
});

app.post('/api/pilot/protocol/toggle', (req: Request, res: Response) => {
  const { id } = req.body;
  const protocol = activeProtocols.find(p => p.id === id);
  if (protocol) {
    protocol.active = !protocol.active;
    broadcastThought(`[PROTOCOL UPDATE] ${protocol.name} status changed to ${protocol.active ? 'ACTIVE' : 'OFFLINE'}`);
    res.json({ success: true, protocol });
  } else {
    res.status(404).json({ error: 'Protocol not found' });
  }
});

// 6. Directive History
app.get('/api/pilot/history', (_req: Request, res: Response) => {
  res.json({ history: directiveHistory });
});

// 7. Video Asset Vault (RenderVault / CineStream review)
app.get('/api/assets/list', (_req: Request, res: Response) => {
  res.json(renderVaultAssets);
});

app.post('/api/assets/review', (req: Request, res: Response) => {
  const { assetId, action } = req.body;
  if (!assetId || !['approve', 'reject'].includes(action)) {
    res.status(400).json({ error: 'Valid assetId and action ("approve" | "reject") are required.' });
    return;
  }

  renderVaultAssets = applyAssetReview(renderVaultAssets, assetId, action);
  const updated = renderVaultAssets.find(a => a.id === assetId);
  broadcastThought(`[RENDER VAULT] Asset ${assetId} review status updated: ${action.toUpperCase()}`);
  res.json({ success: true, asset: updated });
});

// ==========================================
// FEATURE: Direk - AI Movie Director
// The movie-director assistant, merged into the cockpit. It grounds genre
// advice in the bundled Netflix-style catalog and gates on missing essentials.
// ==========================================
const referenceCatalog = new ReferenceCatalog(path.join(__dirname, 'data'), 5);
const marketIntel = new MarketIntel(path.join(__dirname, 'data'));

const direkService = new DirekService(
  referenceCatalog,
  async (systemPrompt, messages) => {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not configured');
    }
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const response = await ai.models.generateContent({
      model: TEXT_MODEL,
      contents,
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.5,
        topP: 0.9,
        maxOutputTokens: 1024,
      },
    });
    return response.text || '';
  },
  () => marketIntel.brief(),
);

app.get('/api/direk/status', (_req: Request, res: Response) => {
  res.json({
    ok: Boolean(process.env.GEMINI_API_KEY),
    model: TEXT_MODEL,
    gemini_key_configured: Boolean(process.env.GEMINI_API_KEY),
    pipeline: PIPELINE,
    genres: Object.keys(GENRE_MAP),
    skills: Object.entries(SKILLS).map(([id, spec]) => ({ id, ...spec })),
    reference_sources: referenceCatalog.sources(),
    market_available: marketIntel.available,
    ...direkService.health(),
  });
});

app.post('/api/direk/chat', async (req: Request, res: Response) => {
  const { messages } = req.body as { messages?: ChatMessage[] };
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages array is required.' });
    return;
  }

  try {
    const result = await direkService.chat(messages);
    broadcastThought(`[DIREK] Genre: ${result.genre ?? 'n/a'} · ${result.reply.slice(0, 60)}...`);
    res.json({
      status: 'success',
      model: TEXT_MODEL,
      reply: result.reply,
      reference_genre: result.genre,
      references: result.references,
      gate: result.gate,
      action: result.action,
      action_error: result.action_error,
      market_brief: result.market_brief,
    });
  } catch (error: any) {
    const reason = error?.message || 'Unknown error';
    console.error(`[DIREK ERROR] ${TEXT_MODEL} chat failed:`, reason);
    broadcastThought(`[DIREK ERROR] ${reason}`);
    res.status(503).json(
      aiUnavailable(TEXT_MODEL, 'Check the server logs and the Gemini API key.', reason)
    );
  }
});

// Box-office market intelligence (real stats, no model needed).
app.get('/api/direk/market', (_req: Request, res: Response) => {
  res.json({
    available: marketIntel.available,
    brief: marketIntel.brief(),
    top_genres: marketIntel.topGenres(),
    top_distributors: marketIntel.topDistributors(),
    production_methods: marketIntel.productionMethods(),
    ratings: marketIntel.ratings(),
  });
});

// Commercial benchmark for a single title, from the TMDB dataset.
app.get('/api/direk/benchmark', (req: Request, res: Response) => {
  const title = typeof req.query.title === 'string' ? req.query.title : '';
  if (!title) {
    res.status(400).json({ error: 'title query parameter is required.' });
    return;
  }
  const benchmark = marketIntel.lookupBenchmark(title);
  if (!benchmark) {
    res.status(404).json({ error: `Walang benchmark para sa '${title}'.` });
    return;
  }
  res.json(benchmark);
});

// Look up catalog titles directly (no model needed).
app.get('/api/direk/reference', (req: Request, res: Response) => {
  const genre = typeof req.query.genre === 'string' ? req.query.genre : null;
  const kind = typeof req.query.kind === 'string' ? req.query.kind : 'Movie';
  const n = typeof req.query.n === 'string' ? parseInt(req.query.n, 10) : undefined;
  if (!genre) {
    res.status(400).json({ error: 'genre query parameter is required.' });
    return;
  }
  res.json({
    genre,
    available: referenceCatalog.available,
    rows: referenceCatalog.size,
    items: referenceCatalog.search(genre, kind, n),
  });
});

function cleanPrompt(p: string): string {
  return p.trim().slice(0, 300);
}

// Mount Vite or serve static files
async function startServer() {
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Battle Room Server running on port ${PORT}`);
  });
}

startServer();
