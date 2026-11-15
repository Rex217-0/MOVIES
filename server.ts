import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { 
  evaluateDirectiveHazard, 
  calculateVitals, 
  parsePilotResponse,
  validateVideoAspectRatio,
  validateImageEditInput,
  buildTacticalVideoPrompt, buildVeoStylePrompt, buildVeoStyleNegative,
  applyAssetReview,
  type VideoAsset
} from './src/tactical/rules.ts';
import {
  IMAGE_MODEL,
  IMAGE_MODEL_FREE,
  TEXT_MODEL,
  TEXT_MODELS,
  isRetryableModelError,
  VIDEO_MODEL,
  VIDEO_MODEL_FREE,
  aiUnavailable,
  NO_FREE_IMAGE_MODEL,
  NO_FREE_VIDEO_MODEL,
} from './src/config.ts';
import { ReferenceCatalog } from './src/direk/reference.ts';
import { MarketIntel } from './src/direk/market.ts';
import { runConnector, connectorCatalog, allAssets } from './src/direk/connectors.ts';
import { ffmpegAvailable, ffmpegPath, toPng } from './src/direk/render.ts';
import { assetsDir, assetPath, reviewAsset, type ReviewStatus } from './src/direk/assets.ts';
import { driveStatus, authUrl, redirectUri, exchangeCode } from './src/direk/gdrive.ts';
import { DirekService, type ChatMessage } from './src/direk/service.ts';
import { PIPELINE, STAGE_SKILL } from './src/direk/pipeline.ts';
import { GENRE_MAP } from './src/direk/genres.ts';
import { SKILLS } from './src/direk/skills.ts';
import { planLora } from './src/direk/loraPlan.ts';
import {
  buildLoraArtifacts, buildLoraZip, buildCaption, isValidTrigger, toSlug,
  numberedName, MAX_LORA_IMAGES,
} from './src/direk/lora.ts';
import {
  comfyAvailable, generateWithComfy, comfyUrl,
  publishLora, listLoras, lorasDir, clampStrength, type LoraChoice,
} from './src/direk/comfyui.ts';
import { pollinationsUrl } from './src/direk/imagine.ts';
import {
  LoRATrainer, trainerStatus, trainingConfig, buildTrainCommand,
} from './src/direk/trainer.ts';
import {
  readSettings, writeSettings, applySettings, effectiveSettings,
  configPath, comfyModelOptions, type DirekSettings,
} from './src/direk/settings.ts';
import {
  ollamaStatus, ollamaChat, preferredTextBackend, ollamaUrl, ollamaModel,
} from './src/direk/llm.ts';
import {
  renderMovie, renderFeatureScene, scriptPrompt, parseScript, fallbackScript, narrationBackends,
  videoBackendReady, videoBackendDetail,
  TTS_MODEL, TTS_VOICES, MOODS,
  type MovieProgress, type MovieScript, type MovieOptions, type Mood, type TtsVoice,
  type NarrationSource,
} from './src/direk/movie.ts';
import { renderVideo } from './src/direk/videoRenderService.ts';
import { MIN_MINUTES, MAX_MINUTES, sceneCount } from './src/movieMeta.ts';
import { groundMovie, groundingBlock } from './src/direk/grounding.ts';
import { FactoryDb, factoryDbPath } from './src/direk/factoryDb.ts';
import { rendersDir, renderPath } from './src/direk/renderStore.ts';
import {
  FeatureFactory, factorySummary,
} from './src/direk/factory.ts';
import {
  breakdownPrompt, parseBreakdown, type ConceptOptions,
} from './src/direk/featureFilm.ts';
import {
  FEATURE_SCENES, FEATURE_SCENE_SECONDS, FEATURE_TOTAL_SECONDS, filmClock,
  RATINGS, FORMATS, RATING_LABELS,
  type Rating, type FilmFormat,
} from './src/featureFilm.ts';
import {
  classifyTask, classifyLoraTraining, planExecution, route_to_cloud,
  routingTable, t3LocalAllowed, TIER_LABELS,
} from './src/direk/taskRouter.ts';
import type { AssetMeta } from './src/direk/assets.ts';
import {
  pilotStatus, writeScreenplay,
  PilotUnavailable, PILOT_UNAVAILABLE, PILOT_MODEL,
} from './src/services/pilotService.ts';

dotenv.config();

// Load the saved runtime settings (ComfyUI / kohya paths) so the backends work
// without hand-editing environment variables. Real env vars still win.
applySettings(readSettings());

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
// The SDK defaults to the stable v1 endpoint, but the current flash models are
// only served on v1beta; without this the calls 404 with "not found for API
// version v1".
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  apiVersion: 'v1beta',
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
  model: TEXT_MODEL as string,
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
app.get('/api/health', async (_req: Request, res: Response) => {
  const keyConfigured = Boolean(process.env.GEMINI_API_KEY);
  const ollama = await ollamaStatus();
  const textAvailable = keyConfigured || (ollama.reachable && ollama.model_present);
  const backend = keyConfigured ? 'gemini' : (ollama.reachable && ollama.model_present ? 'ollama' : 'none');
  res.json({
    ok: textAvailable,
    gemini_key_configured: keyConfigured,
    text: {
      model: backend === 'ollama' ? ollama.model : TEXT_MODEL,
      backend,
      available: textAvailable,
      free_tier: true,
    },
    ollama: {
      url: ollama.url,
      model: ollama.model,
      reachable: ollama.reachable,
      model_present: ollama.model_present,
      models: ollama.models,
      error: ollama.error,
    },
    direk: {
      available: textAvailable,
      free_tier: true,
      model: backend === 'ollama' ? ollama.model : TEXT_MODEL,
      backend,
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
    // The paid cloud connectors are replaced by free local jobs, so this is
    // always available: the only requirement is ffmpeg, which ships with us.
    connectors: {
      available: await ffmpegAvailable(),
      free_tier: true,
      engine: 'ffmpeg (local)',
      assets_dir: assetsDir(),
      skills: connectorCatalog().length,
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
  const directivePrompt = `Commander Directive: "${cleanDirective}"
Analyze and execute this tactical command for the VIP Battle Room.
Respond in strict JSON with:
{
  "intent": "SHORT_UPPERCASE_INTENT",
  "action": "Specific tactical action executed",
  "analysis": "Tactical assessment and reasoning (2-3 sentences)",
  "readiness": "OPTIMAL"
}`;
  const directiveSystem = 'You are the elite AI Pilot Tactical Core in a military sci-fi battle room. Execute directives with analytical rigor.';

  if (!textBackendAvailable) {
    broadcastThought('[SYS] No text model configured - directive not executed.');
    res.status(503).json(
      aiUnavailable(
        TEXT_MODEL,
        'Set GEMINI_API_KEY (free tier), or run a local Ollama model for free.',
        'No text model backend is configured'
      )
    );
    return;
  }

  broadcastThought(`[TEXT REASONING] Calling ${textModelName}...`);

  try {
    const rawText = await generateText(directiveSystem, directivePrompt, { json: true });
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
      model: textModelName,
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
      model: textModelName,
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

  // Heavy video renders on the local ComfyUI GPU (Server-2), with Wan 2.2 on
  // fal.ai as the fallback. The router keeps video local, so a shot is never
  // silently handed to an unconfigured cloud tier.
  const videoPlan = planExecution('video_render', { prompt });
  broadcastThought(`[ROUTER] video_render → ${videoPlan.route.tier} (${videoPlan.run})`);

  broadcastThought(`[VIDEO PIPELINE] Video request for: "${prompt.slice(0, 50)}..." [Aspect: ${validAspect}]`);

  try {
    const { data, engine, editor, editNote } = await renderVideo({
      prompt: formattedPrompt,
      negative: buildVeoStyleNegative(),
      aspectRatio: validAspect,
      resolution,
    });
    if (editNote) broadcastThought(`[VIDEO EDIT] ${editNote}`);
    const elapsedMs = Date.now() - startTime;
    const dataUrl = `data:video/mp4;base64,${data.toString('base64')}`;
    broadcastThought(`[VIDEO COMPLETE] ${engine} video rendered (${elapsedMs}ms).`);
    const mediaRecord: MediaItem = {
      id: `VID-${Date.now()}`,
      type: 'video',
      url: dataUrl,
      prompt: cleanPrompt(prompt),
      aspect_ratio: validAspect,
      timestamp: new Date().toLocaleTimeString(),
      model: engine,
      details: editor ? `${engine} render, edited with ${editor}` : `${engine} render`,
    };
    mediaGallery.unshift(mediaRecord);
    if (mediaGallery.length > 40) mediaGallery.pop();
    renderVaultAssets.unshift({
      id: `ASSET-${Date.now()}`,
      title: cleanPrompt(prompt),
      url: dataUrl,
      status: 'completed',
      reviewStatus: 'pending',
      createdAt: new Date().toISOString(),
    });
    res.json({ status: 'success', item: mediaRecord, latency_ms: elapsedMs });
  } catch (error: any) {
    const reason = error?.message || 'Unknown error';
    const detail = error?.name === 'VideoBackendUnavailable' ? 'Walang video backend.' : 'Check the server logs.';
    console.error('[VIDEO ERROR] render failed:', reason);
    broadcastThought(`[VIDEO ERROR] ${reason}`);
    res.status(503).json(aiUnavailable('video', detail, reason));
  }
});

// ==========================================
// ==========================================
// FEATURE: Create & Edit Images
// ==========================================
app.post('/api/pilot/image/generate', async (req: Request, res: Response) => {
  const { prompt, aspect_ratio, image_size, lora, loraStrength } = req.body;

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ error: 'Image prompt is required.' });
    return;
  }

  const validAspect = aspect_ratio || '1:1';
  const startTime = Date.now();
  // Veo-grade scaffolding: adds camera, lighting and film look when the user
  // did not specify them. Their own wording always wins.
  const enhancedPrompt = buildVeoStylePrompt(prompt);

  // T2 (medium GPU): image generation runs locally on Server-2.
  const imagePlan = planExecution('image_generation', { prompt });
  broadcastThought(`[ROUTER] image_generation → ${imagePlan.route.tier} (${imagePlan.run})`);

  broadcastThought(`[IMAGE PIPELINE] Image request: "${prompt.slice(0, 45)}..."`);

  // ComfyUI (local, free) is preferred. Without it, the paid Gemini image
  // model is used; without either, the feature is honestly unavailable.
  const backend = await resolveImageBackend();
  if (backend === 'comfyui') {
    try {
      const png = await generateWithComfy(enhancedPrompt, {
        negative: buildVeoStyleNegative(),
        width: 1024, height: 1024, lora: parseLoraChoice({ lora, loraStrength }),
      });
      const elapsedMs = Date.now() - startTime;
      const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
      broadcastThought(`[IMAGE COMPLETE] ComfyUI image generated (${elapsedMs}ms).`);
      const mediaRecord: MediaItem = {
        id: `IMG-${Date.now()}`,
        type: 'image',
        url: dataUrl,
        prompt: cleanPrompt(prompt),
        aspect_ratio: validAspect,
        timestamp: new Date().toLocaleTimeString(),
        model: 'comfyui',
        details: 'ComfyUI local generation',
      };
      mediaGallery.unshift(mediaRecord);
      if (mediaGallery.length > 40) mediaGallery.pop();
      res.json({ status: 'success', item: mediaRecord, latency_ms: elapsedMs });
      return;
    } catch (error: any) {
      const reason = error?.message || 'Unknown error';
      console.error(`[IMAGE ERROR] ComfyUI generation failed:`, reason);
      broadcastThought(`[IMAGE ERROR] ComfyUI failed: ${reason}`);
      res.status(503).json(
        aiUnavailable('comfyui', 'Check that ComfyUI is running and reachable.', reason)
      );
      return;
    }
  }

  if (backend === 'none') {
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

// ---------------------------------------------------------------------------
// Text backends: Gemini when a key is set, otherwise a local Ollama model.
// Both are free; Ollama needs no account at all.
// ---------------------------------------------------------------------------
let textBackendCache: { backend: 'gemini' | 'ollama' | 'none'; at: number } | null = null;

async function resolveTextBackend(): Promise<'gemini' | 'ollama' | 'none'> {
  const preferred = preferredTextBackend();
  if (preferred === 'gemini') return 'gemini';
  if (preferred === 'none') return 'none';
  // Cache the Ollama probe briefly so a server started later is picked up.
  if (!textBackendCache || Date.now() - textBackendCache.at > 15000) {
    const status = await ollamaStatus();
    const usable = status.reachable && status.model_present;
    textBackendCache = { backend: usable ? 'ollama' : 'none', at: Date.now() };
  }
  return textBackendCache.backend;
}

let textBackend: 'gemini' | 'ollama' | 'none' = preferredTextBackend();
let textBackendAvailable = textBackend !== 'none';
// Which Gemini model last answered; the list is tried in order.
let geminiModelInUse: string = TEXT_MODEL;
let textModelName = textBackend === 'gemini' ? TEXT_MODEL : ollamaModel();

async function refreshTextBackend(): Promise<void> {
  textBackend = await resolveTextBackend();
  textBackendAvailable = textBackend !== 'none';
  textModelName = textBackend === 'gemini' ? geminiModelInUse : ollamaModel();
}

/**
 * One text completion, from whichever backend is available. `messages` are the
 * plain conversation turns; the system prompt is passed separately.
 */
async function generateText(
  system: string,
  messages: ChatMessage[] | string,
  opts: { json?: boolean; temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  await refreshTextBackend();
  if (!textBackendAvailable) {
    throw new Error('No text model is configured (set GEMINI_API_KEY, or run Ollama)');
  }
  if (textBackend === 'ollama') {
    const turns: { role: 'user' | 'assistant'; content: string }[] =
      typeof messages === 'string'
        ? [{ role: 'user', content: messages }]
        : messages
            .filter(m => m.role !== 'system')
            .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    return ollamaChat({
      system,
      messages: turns,
      json: opts.json,
      temperature: opts.temperature ?? 0.7,
    });
  }
  // Gemini
  const contents = typeof messages === 'string'
    ? messages
    : messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
  let lastError: any = null;
  for (const model of TEXT_MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: system,
          temperature: opts.temperature ?? 0.7,
          topP: 0.9,
          maxOutputTokens: opts.maxTokens ?? 1024,
          ...(opts.json ? { responseMimeType: 'application/json' } : {}),
        },
      });
      geminiModelInUse = model;
      return response.text || '';
    } catch (error: any) {
      lastError = error;
      // Retire/rate-limit errors: try the next model. Anything else is real.
      if (!isRetryableModelError(error?.message || '')) throw error;
    }
  }
  throw lastError || new Error('No Gemini text model was usable');
}

const direkService = new DirekService(
  referenceCatalog,
  async (systemPrompt, messages) => {
    return generateText(systemPrompt, messages, { temperature: 0.5 });
  },
  () => marketIntel.brief(),
);

app.get('/api/direk/status', async (_req: Request, res: Response) => {
  const backend = await resolveImageBackend();
  await refreshTextBackend();
  res.json({
    ok: textBackendAvailable,
    model: textModelName,
    text_backend: textBackend,
    gemini_key_configured: Boolean(process.env.GEMINI_API_KEY),
    pipeline: PIPELINE,
    genres: Object.keys(GENRE_MAP),
    skills: Object.entries(SKILLS).map(([id, spec]) => ({ id, ...spec })),
    reference_sources: referenceCatalog.sources(),
    market_available: marketIntel.available,
    image_backend: backend,
    comfyui_url: comfyUrl(),
    ...direkService.health(),
  });
});

// The T1/T2/T3 routing table: where each task type is allowed to run. The UI
// shows this so it is always clear which jobs load the local GPU.
app.get('/api/direk/routing', (_req: Request, res: Response) => {
  res.json({
    tiers: TIER_LABELS,
    t3_allow_local: process.env.T3_ALLOW_LOCAL !== '0',
    cloud_configured: Boolean(process.env.CLOUD_T3_URL),
    table: routingTable(),
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

    // An API skill used to be a dead end. Now it runs the free local connector
    // so the reply comes with a real file. Confirmed skills wait for the user.
    let connector = null;
    if (result.action && result.action.status === 'ready') {
      broadcastThought(`[CONNECTOR] ${result.action.skill} → ${result.action.connector} (free, local)`);
      connector = await runConnector(result.action.skill, result.action.args);
      broadcastThought(`[CONNECTOR] ${connector.ok ? 'OK' : 'FAIL'}: ${connector.note}`);
    }

    broadcastThought(`[DIREK] Genre: ${result.genre ?? 'n/a'} · ${result.reply.slice(0, 60)}...`);
    res.json({
      status: 'success',
      model: textModelName,
      reply: result.reply,
      reference_genre: result.genre,
      references: result.references,
      gate: result.gate,
      action: result.action,
      action_error: result.action_error,
      connector,
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

// ---------------------------------------------------------------------------
// Movie Creator: one brief in, one downloadable film out.
// ---------------------------------------------------------------------------
const movieJobs = new Map<string, MovieJob>();

interface MovieJob {
  id: string;
  brief: string;
  minutes: number;
  stage: string;
  percent: number;
  detail?: string;
  status: 'running' | 'done' | 'error';
  title?: string;
  scenes?: number;
  seconds?: number;
  narrated?: boolean;
  voiceSource?: NarrationSource;
  note?: string;
  asset?: AssetMeta;
  /** What the screenplay was grounded in, for the UI and the logs. */
  grounding?: { genre: string | null; references: number; market: boolean; pacing: string };
  error?: string;
  startedAt: number;
  endedAt?: number;
}

app.get('/api/direk/movie/status', (_req: Request, res: Response) => {
  const backends = narrationBackends();
  res.json({
    available: true,
    narration: backends.fish || backends.cloud || backends.tagalog || backends.offline,
    narration_fish: backends.fish,
    narration_cloud: backends.cloud,
    narration_tagalog: backends.tagalog,
    narration_offline: backends.offline,
    narration_order: backends.order,
    piper_voice: backends.piper_voice,
    tagalog_model: backends.tagalog_model,
    tagalog_python: backends.tagalog_python,
    tts_model: TTS_MODEL,
    voices: TTS_VOICES,
    moods: MOODS,
    min_minutes: MIN_MINUTES,
    max_minutes: MAX_MINUTES,
    ffmpeg: Boolean(ffmpegPath()),
    jobs: [...movieJobs.values()].slice(-10).reverse(),
  });
});

app.post('/api/direk/movie', async (req: Request, res: Response) => {
  const body = req.body as { brief?: string; minutes?: number; mood?: string; voice?: string; title?: string };
  const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
  if (!brief) {
    res.status(400).json({ error: 'Kailangan ng brief (isang pangungusap na ideya).' });
    return;
  }
  const minutes = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Number(body.minutes) || 1));
  const mood = (MOODS as string[]).includes(String(body.mood)) ? (body.mood as Mood) : undefined;
  const voice = (TTS_VOICES as readonly string[]).includes(String(body.voice)) ? (body.voice as TtsVoice) : undefined;
  const opts: MovieOptions = { minutes, mood, voice, title: body.title };

  // Ground the screenplay in the real datasets before the model is asked to
  // write: the reference catalog (real titles/genres) and the box-office stats.
  const grounding = groundMovie(brief, { minutes, sceneCount: sceneCount(minutes) }, referenceCatalog, marketIntel);
  const groundingText = groundingBlock(grounding);
  broadcastThought(
    `[MOVIE] Grounding: ${grounding.references.length} reference · ` +
    `${grounding.genre ?? 'walang genre'} · ${grounding.market_brief ? 'may market stats' : 'walang market stats'}`,
  );

  const id = `MOV-${Date.now()}`;
  const job: MovieJob = { id, brief, minutes, stage: 'Simula', percent: 0, status: 'running', startedAt: Date.now() };
  movieJobs.set(id, job);
  while (movieJobs.size > 30) movieJobs.delete(movieJobs.keys().next().value as string);

  res.status(202).json({ status: 'accepted', job: id });

  const tick = (p: MovieProgress) => {
    job.stage = p.stage;
    job.percent = p.percent;
    job.detail = p.detail;
    broadcastThought(`[MOVIE ${p.percent}%] ${p.stage}${p.detail ? ` · ${p.detail}` : ''}`);
  };

  try {
    // Screenplay first: a text model when one is available, otherwise the
    // built-in beat sheet, so a film still comes out with no model at all.
    tick({ stage: 'Script', percent: 1 });
    let script: MovieScript | null = null;
    try {
      const raw = await generateText(scriptPrompt(brief, opts, groundingText), [{ role: 'user', content: brief }], {
        json: true,
        temperature: 0.9,
        maxTokens: 8192,
      });
      script = parseScript(raw);
    } catch (error: any) {
      broadcastThought(`[MOVIE] Walang text model (${error?.message || 'error'}) — gagamitin ang built-in na beats.`);
    }
    if (!script) script = fallbackScript(brief, opts);

    const result = await renderMovie(script, opts, tick);
    job.status = 'done';
    job.title = script.title;
    job.scenes = result.scenes;
    job.seconds = result.seconds;
    job.narrated = result.narrated;
    job.voiceSource = result.voice_source;
    job.note = result.note;
    job.asset = result.asset;
    job.grounding = {
      genre: grounding.genre,
      references: grounding.references.length,
      market: Boolean(grounding.market_brief),
      pacing: grounding.pacing,
    };
    job.endedAt = Date.now();
    broadcastThought(`[MOVIE DONE] ${script.title} · ${result.seconds.toFixed(0)}s`);
  } catch (error: any) {
    job.status = 'error';
    job.error = error?.message || 'Hindi nagawa ang pelikula.';
    job.endedAt = Date.now();
    broadcastThought(`[MOVIE ERROR] ${job.error}`);
  }
});

// ---------------------------------------------------------------------------
// Feature Film Factory: one concept -> an 18-scene, 90-minute feature.
// Each scene is rendered alone and lands in the Staging Vault for review; the
// approved scenes are stitched with `ffmpeg -c copy` at the end.
// ---------------------------------------------------------------------------
const featureDb = new FactoryDb();
const featureFactory = new FeatureFactory({
  // Every scene is a real ComfyUI render. When ComfyUI cannot render the shot
  // (unreachable, no video workflow) the scene fails with AI_UNAVAILABLE; the
  // factory never fabricates a placeholder clip.
  renderScene: async ({ scene, index, onStage }) => {
    const result = await renderFeatureScene(scene, { index, seconds: FEATURE_SCENE_SECONDS, onStage });
    return { data: result.data, seconds: result.seconds, voiced: result.voiced };
  },
  ffmpegAvailable,
  // Local SQLite store for MovieJobs and SceneJobs (factory.db).
  db: featureDb,
});

function featureView(job: ReturnType<FeatureFactory['create']>) {
  return {
    ...job,
    totalSeconds: FEATURE_TOTAL_SECONDS,
    filmClock: filmClock(job.renderedSeconds),
    totalClock: filmClock(FEATURE_TOTAL_SECONDS),
  };
}

app.get('/api/direk/feature/status', async (req: Request, res: Response) => {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  const job = id ? featureFactory.refresh(id) : featureFactory.latest();
  const backends = narrationBackends();
  const pilot = await pilotStatus();
  res.json({
    available: true,
    scenes: FEATURE_SCENES,
    scene_seconds: FEATURE_SCENE_SECONDS,
    total_seconds: FEATURE_TOTAL_SECONDS,
    total_clock: filmClock(FEATURE_TOTAL_SECONDS),
    ratings: RATINGS,
    rating_labels: RATING_LABELS,
    formats: FORMATS,
    narration_order: backends.order,
    ffmpeg: Boolean(ffmpegPath()),
    pilot: {
      configured: pilot.configured,
      reachable: pilot.reachable,
      url: pilot.url,
      detail: pilot.detail,
      preferred: pilot.preferred,
      local: pilot.local,
    },
    job: job ? featureView(job) : null,
  });
});

app.post('/api/direk/feature/create', async (req: Request, res: Response) => {
  const body = req.body as {
    brief?: string; title?: string; genre?: string; rating?: string; format?: string; mood?: string;
  };
  const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
  if (!brief) {
    res.status(400).json({ error: 'Kailangan ng brief (isang pangungusap na ideya).' });
    return;
  }
  const rating = (RATINGS as readonly string[]).includes(String(body.rating)) ? (body.rating as Rating) : undefined;
  const format = (FORMATS as readonly string[]).includes(String(body.format)) ? (body.format as FilmFormat) : undefined;
  const mood = (MOODS as string[]).includes(String(body.mood)) ? (body.mood as Mood) : undefined;
  const opts: ConceptOptions = { brief, title: body.title, genre: body.genre, rating, format, mood };
  const job = featureFactory.create(opts);

  // A richer breakdown from a text model when one is available; the built-in
  // 18-beat structure stands in when there is none.
  try {
    const raw = await generateText(breakdownPrompt(job.concept), [{ role: 'user', content: brief }], {
      json: true, temperature: 0.9, maxTokens: 8192,
    });
    const parsed = parseBreakdown(raw);
    if (parsed) featureFactory.applyBreakdown(job.id, parsed);
  } catch (error: any) {
    broadcastThought(`[FILM] Walang text model (${error?.message || 'error'}) — built-in 18-beat breakdown ang gagamitin.`);
  }
  broadcastThought(`[FILM] ${factorySummary(job)}`);
  res.status(201).json({ job: featureView(job) });
});

// ---------------------------------------------------------------------------
// Kaggle Pilot bridge: the external cloud worker (Qwen 2.5 3B on Kaggle) writes
// the screenplay, the character bible and the 18-scene breakdown. It is reached
// over a Cloudflare tunnel (KAGGLE_PILOT_URL). When the worker is down the call
// answers an honest 503 PILOT_UNAVAILABLE — the factory never invents a script.
// ---------------------------------------------------------------------------
function pilotUnavailableBody(detail: string) {
  return {
    error: `Walang Kaggle Pilot. ${detail}`,
    code: PILOT_UNAVAILABLE,
    model: PILOT_MODEL,
    detail,
  };
}

app.get('/api/direk/feature/pilot', async (_req: Request, res: Response) => {
  const status = await pilotStatus();
  res.json(status);
});

app.post('/api/direk/feature/pilot', async (req: Request, res: Response) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  const job = id ? featureFactory.get(id) : undefined;
  if (!job) {
    res.status(404).json({ error: 'Walang ganoong pelikula. Gumawa muna ng concept.' });
    return;
  }
  const brief = job.concept.brief;
  try {
    broadcastThought(`[PILOT] Hinihingi ang script (Kaggle, o local Ollama kung wala)…`);
    const result = await writeScreenplay(brief);
    const updated = featureFactory.applyScript(job.id, result.script, {
      bible: result.bible,
      scenes: result.scenes ? { scenes: result.scenes } : undefined,
    })!;
    broadcastThought(`[PILOT] Script + ${result.scenes?.length ?? 0} eksena mula sa ${result.model}, nai-save sa SQLite.`);
    res.json({
      job: featureView(updated),
      script_chars: result.script.length,
      bible: Boolean(result.bible),
      scenes: updated.scenes.length,
      source: result.source,
      model: result.model,
      pilot: await pilotStatus(),
    });
  } catch (error: any) {
    const detail = error instanceof PilotUnavailable ? error.detail : error?.message || 'error';
    broadcastThought(`[PILOT] Hindi available: ${detail}`);
    res.status(503).json(pilotUnavailableBody(detail));
  }
});

app.post('/api/direk/feature/start', async (req: Request, res: Response) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  const job = id ? featureFactory.get(id) : undefined;
  if (!job) {
    res.status(404).json({ error: 'Walang ganoong pelikula. Gumawa muna ng concept.' });
    return;
  }

  // Step 1 — the screenplay. START BATCH asks the Kaggle Pilot (T3 heavy
  // batch) for the 18-scene script and stores it in SQLite; when Kaggle is
  // unset or down it falls back to the local Ollama (T1, real time). A Pilot
  // that is expected (configured, or a reachable local model) but fails is a
  // real failure, so this answers 503 PILOT_UNAVAILABLE rather than quietly
  // switching sources. With no Pilot at all, the built-in 18-beat plan is used
  // so the factory still runs offline.
  try {
    broadcastThought(`[PILOT] Hinihingi ang 18-scene script (Kaggle, o local Ollama kung wala)…`);
    const result = await writeScreenplay(job.concept.brief);
    featureFactory.applyScript(job.id, result.script, {
      bible: result.bible,
      scenes: result.scenes ? { scenes: result.scenes } : undefined,
    });
    broadcastThought(`[PILOT] Script + ${result.scenes?.length ?? 0} eksena mula sa ${result.model}, nai-save sa SQLite.`);
  } catch (error: any) {
    const detail = error instanceof PilotUnavailable ? error.detail : error?.message || 'error';
    const status = await pilotStatus();
    if (status.configured || status.local.reachable) {
      broadcastThought(`[PILOT] Hindi available: ${detail}`);
      res.status(503).json(pilotUnavailableBody(detail));
      return;
    }
    broadcastThought(`[PILOT] Walang Pilot (Kaggle o local Ollama) — built-in 18-beat breakdown ang gagamitin.`);
  }

  // Step 2 — a real video backend, or every scene would fail. Answer 503 up
  // front instead of starting 18 doomed renders.
  if (!(await videoBackendReady())) {
    broadcastThought(`[FILM] Batch START tinanggihan: walang video backend.`);
    res.status(503).json({
      ...aiUnavailable('comfyui', videoBackendDetail(), 'Walang video backend'),
      route: classifyTask('video_render'),
    });
    return;
  }
  const started = featureFactory.start(id)!;
  broadcastThought(`[FILM] Batch START · ${started.concept.title} · ${started.total} eksena`);
  res.json({ job: featureView(started), pilot: await pilotStatus() });
});

app.post('/api/direk/feature/pause', (req: Request, res: Response) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  const job = id ? featureFactory.pause(id) : undefined;
  if (!job) {
    res.status(404).json({ error: 'Walang ganoong pelikula.' });
    return;
  }
  broadcastThought(`[FILM] Batch PAUSE · ${job.concept.title}`);
  res.json({ job: featureView(job) });
});

app.post('/api/direk/feature/rerender', async (req: Request, res: Response) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  const index = Number(req.body?.scene);
  const job = id ? await featureFactory.rerender(id, index) : undefined;
  if (!job) {
    res.status(404).json({ error: 'Walang ganoong pelikula o eksena.' });
    return;
  }
  res.json({ job: featureView(job) });
});

app.post('/api/direk/feature/assemble', async (req: Request, res: Response) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  const job = id ? featureFactory.get(id) : undefined;
  if (!job) {
    res.status(404).json({ error: 'Walang ganoong pelikula.' });
    return;
  }
  try {
    const film = await featureFactory.assemble(job);
    if (!film) {
      res.status(400).json({ error: 'Kailangan ng hindi bababa sa dalawang aprubadong eksena.' });
      return;
    }
    broadcastThought(`[FILM] Naidugtong: ${film.assetName} · ${filmClock(film.seconds)}`);
    res.json({ job: featureView(job), film });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Hindi naidugtong ang pelikula.' });
  }
});

// Stitch one film by id: gather its 18 approved scenes and join them with
// `ffmpeg -c copy`. Works even if the in-memory job is gone, by reading the
// scene list back from factory.db.
app.post('/api/direk/feature/stitch', async (req: Request, res: Response) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : typeof req.body?.movie_id === 'string' ? req.body.movie_id : '';
  if (!id) {
    res.status(400).json({ error: 'Kailangan ang movie id.' });
    return;
  }
  try {
    const film = await featureFactory.stitchMovie(id);
    if (!film) {
      res.status(400).json({ error: 'Kailangan ng hindi bababa sa dalawang aprubadong eksena.' });
      return;
    }
    broadcastThought(`[FILM] stitchMovie(${id}) → ${film.assetName} · ${filmClock(film.seconds)}`);
    const job = featureFactory.get(id);
    res.json({ movie_id: id, film, job: job ? featureView(job) : null });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Hindi naidugtong ang pelikula.' });
  }
});

// Local factory database: which films and scenes are stored.
app.get('/api/direk/factory/db', (_req: Request, res: Response) => {
  const movies = featureDb.list();
  res.json({
    database: factoryDbPath(),
    renders_dir: rendersDir(),
    movies: movies.length,
    scenes: movies.reduce((n, m) => n + featureDb.sceneCount(m.id), 0),
    jobs: movies.map(m => ({ id: m.id, title: m.concept.title, status: m.status, scenes: m.scenes.length })),
  });
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

// ---------------------------------------------------------------------------
// LoRA training sets
// Direk turns a brief into a LoRA training set, reusing the catalog, the
// box-office presets and the character bible. Deterministic: no model needed.
// ---------------------------------------------------------------------------

interface LoraRequestBody {
  title?: string;
  genre?: string;
  mood?: string;
  durationMinutes?: number;
  trigger?: string;
  character?: { name?: string; look?: string; wardrobe?: string; voice?: string };
  baseModel?: string;
}

function parseLoraBody(body: LoraRequestBody) {
  const title = (body.title || '').trim();
  const genre = (body.genre || '').trim();
  const mood = (body.mood || '').trim();
  if (!title || !genre || !mood) {
    return { error: 'title, genre, and mood are required.' as const };
  }
  if (body.trigger && !isValidTrigger(body.trigger)) {
    return {
      error:
        'Invalid trigger token. Use lowercase letters, digits and underscores (3-40 chars).',
    } as const;
  }
  const plan = planLora(
    {
      title,
      genre,
      mood,
      durationMinutes: Number(body.durationMinutes) || undefined,
      trigger: body.trigger?.trim() || undefined,
      character: body.character,
      baseModel: body.baseModel?.trim() || undefined,
    },
    referenceCatalog,
    marketIntel,
  );
  return { plan } as const;
}

// ---------------------------------------------------------------------------
// Image backends
// ComfyUI (local, free) is preferred; the paid Gemini image model is a
// fallback. With neither, image features are honestly reported as unavailable.
// ---------------------------------------------------------------------------
type ImageBackend = 'comfyui' | 'gemini' | 'pollinations' | 'none';

let comfyOk: { ok: boolean; at: number } | null = null;

async function resolveImageBackend(): Promise<ImageBackend> {
  if (process.env.COMFYUI_DISABLE !== '1') {
    // Re-probe at most every 15s so a ComfyUI that starts later is picked up.
    if (!comfyOk || Date.now() - comfyOk.at > 15000) {
      comfyOk = { ok: await comfyAvailable(), at: Date.now() };
    }
    if (comfyOk.ok) return 'comfyui';
  }
  if (process.env.GEMINI_API_KEY && IMAGE_MODEL_FREE) return 'gemini';
  // Pollinations needs no key and no GPU, so it is the free default.
  if (process.env.POLLINATIONS_DISABLE !== '1') return 'pollinations';
  return 'none';
}

/**
 * Generate one image with Pollinations (free, no key, no GPU needed).
 *
 * The free tier allows one image every 45 seconds per IP and answers 402 with
 * the wait it wants, so honour that wait and retry instead of losing the image.
 */
async function generatePollinationsImage(prompt: string, seed = 0): Promise<Buffer> {
  const url = `${pollinationsUrl()}/prompt/${encodeURIComponent(prompt)}` +
    `?width=1024&height=1024&nologo=true&seed=${seed}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) throw new Error('Pollinations returned an empty image');
      return buf;
    }
    if (res.status === 402) {
      const body = await res.text().catch(() => '');
      const wait = Number(/retry after (\d+)/i.exec(body)?.[1] ?? 45) + 2;
      broadcastThought(`[DIREK] Pollinations rate limit — hinihintay ${wait}s...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    throw new Error(`Pollinations returned ${res.status}`);
  }
  throw new Error('Pollinations: naabot ang rate limit');
}

/** Generate one image with the paid Gemini image model. */
async function generateGeminiImage(prompt: string): Promise<Buffer | null> {
  const interaction = await ai.interactions.create({
    model: IMAGE_MODEL,
    input: prompt,
    response_modalities: ['image', 'text'],
    generation_config: { image_config: { aspect_ratio: '1:1', image_size: '1K' } },
  });
  const dataUrl = extractImageFromInteraction(interaction);
  if (!dataUrl) return null;
  const comma = dataUrl.indexOf(',');
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
}

function generateLoraImage(
  prompt: string,
  backend: ImageBackend,
  lora?: LoraChoice,
  seed = 0,
): Promise<Buffer | null> {
  // The LoRA only applies to ComfyUI; the hosted paths have no LoRA concept.
  // Every path ends in toPng: the hosted backends answer with a JPEG, and a
  // JPEG under a `.png` name is not a usable LoRA training image.
  if (backend === 'comfyui') return generateWithComfy(prompt, { lora });
  if (backend === 'pollinations') return generatePollinationsImage(prompt, seed).then(toPng);
  return generateGeminiImage(prompt).then(png => (png ? toPng(png) : null));
}

function noImageNote(): string {
  return (
    `Walang larawan: walang image backend. Magpatakbo ng ComfyUI (COMFYUI_URL=${comfyUrl()}) ` +
    `para sa libreng local na generation, o hayaan ang libreng Pollinations backend.`
  );
}

// Preview the plan and the generated artifacts (no zip).
app.post('/api/direk/lora/plan', async (req: Request, res: Response) => {
  const parsed = parseLoraBody(req.body as LoraRequestBody);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { plan } = parsed;
  const backend = await resolveImageBackend();
  // Where this set's pieces are routed: the text half is T1, the images T2, and
  // a training run is T2 or T3 depending on its size.
  const textRoute = classifyTask('lora_text');
  const imageRoute = classifyTask('image_generation');
  const trainRoute = classifyLoraTraining({ samples: plan.brief.samples.length });
  res.json({
    trigger: plan.brief.trigger,
    genre: plan.brief.genre,
    mood: plan.brief.mood,
    samples: plan.brief.samples.length,
    character: plan.brief.character,
    base_model: plan.brief.baseModel || 'stabilityai/stable-diffusion-xl-base-1.0',
    references: plan.references,
    notes: plan.notes,
    artifacts: buildLoraArtifacts(plan.brief).map(a => a.filename),
    images_available: backend !== 'none',
    image_backend: backend,
    max_images: MAX_LORA_IMAGES,
    routing: { text: textRoute, images: imageRoute, training: trainRoute },
  });
});

/** Run `worker` over `items` with a small concurrency limit. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/** Read a LoRA selection out of a request body, or undefined for none. */
function parseLoraChoice(body: { lora?: string; loraStrength?: number }): LoraChoice | undefined {
  const name = (body.lora || '').trim();
  if (!name) return undefined;
  return { name, strength: clampStrength(body.loraStrength) };
}

/**
 * Generate the sample images for a plan. Shared by the zip download and the
 * trainer, so both produce the same set.
 */
async function generateLoraImages(
  plan: ReturnType<typeof planLora>,
  wantImages: boolean,
  lora?: LoraChoice,
): Promise<{ images: Map<string, Buffer>; skipped: string[]; imageNote?: string }> {
  const images = new Map<string, Buffer>();
  const skipped: string[] = [];
  let imageNote: string | undefined;

  const backend = wantImages ? await resolveImageBackend() : 'none';
  if (!wantImages) {
    imageNote = 'Hindi hiningi ang larawan para sa set na ito (images: false).';
  } else if (backend === 'none') {
    imageNote = noImageNote();
    broadcastThought('[DIREK] LoRA set: text-only (no image backend)');
  } else {
    const targets = plan.brief.samples.slice(0, MAX_LORA_IMAGES);
    broadcastThought(`[DIREK] LoRA set: ${targets.length} images via ${backend}...`);
    const names = targets.map((_s, i) => numberedName(plan.brief.trigger, i));
    // ComfyUI serialises on one GPU, so keep it to one job at a time.
    // ComfyUI serialises on one GPU and Pollinations allows one image per IP
    // every 45s, so both run one at a time; Gemini can take a few at once.
    const limit = backend === 'gemini' ? 3 : 1;
    await mapLimited(targets, limit, async (sample, i) => {
      const name = names[i];
      try {
        const png = await generateLoraImage(sample.prompt, backend, lora, i + 1);
        if (png) images.set(name, png);
        else skipped.push(name);
      } catch (error: any) {
        skipped.push(name);
        console.error(`[DIREK] image ${name} failed:`, error?.message || error);
      }
      return null;
    });
    if (plan.brief.samples.length > MAX_LORA_IMAGES) {
      imageNote = `Larawan lang para sa unang ${MAX_LORA_IMAGES} samples (cap).`;
    }
    if (skipped.length) {
      imageNote = `${imageNote ? imageNote + ' ' : ''}${skipped.length} sample(s) na bigo.`;
    }
  }
  return { images, skipped, imageNote };
}

// Download the whole LoRA training set as a zip. When an image model is
// available, the sample images are generated and bundled too; otherwise the
// zip still contains the text half and an IMAGES.md explaining the gap.
app.post('/api/direk/lora/dataset', async (req: Request, res: Response) => {
  const body = req.body as LoraRequestBody & { images?: boolean; lora?: string; loraStrength?: number };
  const parsed = parseLoraBody(body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { plan } = parsed;
  const lora = parseLoraChoice(body);
  const { images, skipped, imageNote } = await generateLoraImages(plan, body.images !== false, lora);

  const zip = buildLoraZip(plan.brief, { images, skipped, imageNote });
  const name = `${toSlug(plan.brief.title)}_${plan.brief.trigger}_lora.zip`;
  broadcastThought(
    `[DIREK] LoRA set ready: ${plan.brief.samples.length} samples · ${images.size} images`,
  );
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(zip);
});

// ---------------------------------------------------------------------------
// LoRA training
// Runs kohya_ss / sd-scripts locally. Nothing is faked: with no trainer
// installed the endpoints report it as unavailable.
// ---------------------------------------------------------------------------
const loraTrainer = new LoRATrainer();
const RUNS_ROOT = process.env.KOHYA_RUNS_ROOT || path.join(process.cwd(), 'lora_runs');
// Default the trained output next to each run's dataset, so a run is self-contained.
if (!process.env.KOHYA_OUTPUT_DIR) process.env.KOHYA_OUTPUT_DIR = RUNS_ROOT;

function jobSummary() {
  const job = loraTrainer.current();
  if (!job) return null;
  return {
    id: job.id,
    title: job.title,
    trigger: job.trigger,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    outputDir: job.outputDir,
    artifact: job.artifact,
    error: job.error,
    log: job.log,
  };
}

app.get('/api/direk/train/status', (_req: Request, res: Response) => {
  const status = trainerStatus();
  res.json({ ...status, job: jobSummary() });
});

// The LoRAs available to ComfyUI: trained ones Direk published, plus any the
// user dropped into the same folder.
app.get('/api/direk/lora/list', (_req: Request, res: Response) => {
  res.json({ dir: lorasDir(), loras: listLoras() });
});

// ---------------------------------------------------------------------------
// Setup: the local backend paths, editable from the UI so a fresh install
// needs no hand-editing of environment variables.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Free connectors: each paid skill mapped to a real local job.
// ---------------------------------------------------------------------------
app.get('/api/direk/connectors', async (_req: Request, res: Response) => {
  res.json({
    ready: await ffmpegAvailable(),
    ffmpeg: ffmpegPath(),
    assets_dir: assetsDir(),
    catalog: connectorCatalog(),
  });
});

app.post('/api/direk/connectors/run', async (req: Request, res: Response) => {
  const { skill, args } = req.body as { skill?: string; args?: Record<string, unknown> };
  if (!skill) {
    res.status(400).json({ error: 'skill is required.' });
    return;
  }
  broadcastThought(`[CONNECTOR] Manual run: ${skill}`);
  const result = await runConnector(skill, args ?? {});
  broadcastThought(`[CONNECTOR] ${result.ok ? 'OK' : 'FAIL'}: ${result.note}`);
  res.status(result.ok ? 200 : 400).json(result);
});

app.get('/api/direk/assets', (_req: Request, res: Response) => {
  res.json({ assets: allAssets() });
});

// Approve or reject a rendered asset in the Staging Vault. The decision is
// written back to the asset's sidecar, so it survives a restart and the
// Published view keeps only what was really approved.
app.post('/api/direk/assets/review', (req: Request, res: Response) => {
  const body = req.body as { id?: string; name?: string; assetId?: string; action?: string };
  const target = body.id || body.assetId || body.name;
  const action = body.action;
  if (!target || !['approve', 'reject', 'pending'].includes(String(action))) {
    res.status(400).json({
      error: 'Kailangan ang asset id (o name) at action: "approve" | "reject" | "pending".',
    });
    return;
  }
  const status: ReviewStatus =
    action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'pending';
  const updated = reviewAsset(target, status);
  if (!updated) {
    res.status(404).json({ error: `Hindi mahanap ang asset na '${target}'.` });
    return;
  }
  broadcastThought(`[RENDER VAULT] ${updated.name} → ${status}`);
  res.json({ ok: true, asset: updated });
});

app.get('/api/direk/assets/:name/download', (req: Request, res: Response) => {
  const full = assetPath(String(req.params.name));
  if (!full) {
    res.status(404).json({ error: 'Hindi mahanap ang asset.' });
    return;
  }
  res.download(full);
});

// Local render store: finished .mp4 files (scenes and stitched features) are
// served straight from `public/renders/` so the browser can play or download
// them without going through the asset vault.
app.get('/renders/:name', (req: Request, res: Response) => {
  const full = renderPath(String(req.params.name));
  if (!full) {
    res.status(404).json({ error: 'Hindi mahanap ang render.' });
    return;
  }
  res.sendFile(full);
});

// Google Drive API v3: status, consent, and the callback Google redirects to.
app.get('/api/direk/drive/status', (req: Request, res: Response) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json(driveStatus(base));
});

app.get('/api/direk/drive/auth', (req: Request, res: Response) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const status = driveStatus(base);
  if (!status.configured) {
    res.status(400).json({
      error: 'Kailangan ng GDRIVE_CLIENT_ID at GDRIVE_CLIENT_SECRET.',
      redirect_uri: status.redirect_uri,
    });
    return;
  }
  res.redirect(authUrl(status.redirect_uri));
});

app.get('/api/direk/drive/callback', async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const base = `${req.protocol}://${req.get('host')}`;
  if (!code) {
    res.status(400).send('Walang code mula sa Google.');
    return;
  }
  try {
    await exchangeCode(code, redirectUri(base));
    broadcastThought('[GDRIVE] Naka-authorize na ang Google Drive.');
    res.send('<h2>Ayos! Naka-connect na ang Google Drive.</h2><p>Puwede mo nang isara ang tab na ito.</p>');
  } catch (error: any) {
    res.status(500).send(`<h2>Nabigo</h2><pre>${String(error?.message || error)}</pre>`);
  }
});

app.get('/api/direk/settings', (_req: Request, res: Response) => {
  const { settings, source } = effectiveSettings();
  res.json({ config_path: configPath(), settings, source });
});

app.put('/api/direk/settings', (req: Request, res: Response) => {
  const body = (req.body || {}) as DirekSettings;
  const allowed: (keyof DirekSettings)[] = [
    'comfyui_url', 'comfyui_checkpoint', 'comfyui_workflow', 'comfyui_loras_dir',
    'kohya_dir', 'kohya_base_model', 'kohya_python', 'kohya_accelerate', 'kohya_output_dir',
    'ollama_url', 'ollama_model',
  ];
  const clean: DirekSettings = {};
  for (const key of allowed) {
    if (body[key] !== undefined) (clean as any)[key] = body[key];
  }
  writeSettings(clean);
  // Apply live so the next request already uses the new paths.
  applySettings(clean, true);
  comfyOk = null;
  textBackendCache = null;
  res.json({ saved: true, config_path: configPath(), settings: clean });
});

// One call the UI makes on load: is everything wired up and working?
app.get('/api/direk/setup', async (_req: Request, res: Response) => {
  const comfy = await comfyModelOptions();
  const trainer = trainerStatus();
  const ollama = await ollamaStatus();
  const gemini = Boolean(process.env.GEMINI_API_KEY);
  const textReady = gemini || (ollama.reachable && ollama.model_present);
  res.json({
    config_path: configPath(),
    text: {
      backend: gemini ? 'gemini' : (textReady ? 'ollama' : 'none'),
      gemini_key: gemini,
      model: gemini ? TEXT_MODEL : ollama.model,
      ready: textReady,
      ollama: {
        url: ollama.url,
        model: ollama.model,
        reachable: ollama.reachable,
        model_present: ollama.model_present,
        models: ollama.models,
        error: ollama.error,
      },
    },
    comfyui: {
      url: comfyUrl(),
      reachable: comfy.reachable,
      checkpoints: comfy.checkpoints,
      loras: comfy.loras,
      error: comfy.error,
    },
    trainer: { available: trainer.available, reason: trainer.reason, base_model: trainer.base_model },
    loras_dir: lorasDir(),
    published_loras: listLoras(),
    ready: textReady && comfy.reachable && trainer.available,
  });
});

// Start training. Generates the images first (so there is something to train
// on), writes the dataset to disk, then launches the trainer.
app.post('/api/direk/train/start', async (req: Request, res: Response) => {
  const body = req.body as LoraRequestBody & {
    images?: boolean;
    epochs?: number;
    resolution?: number;
    networkDim?: number;
    numRepeats?: number;
    lora?: string;
    loraStrength?: number;
  };
  const parsed = parseLoraBody(body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const status = trainerStatus();
  if (!status.available) {
    res.status(503).json({ error: status.reason, code: 'TRAINER_UNAVAILABLE' });
    return;
  }
  const { plan } = parsed;
  const lora = parseLoraChoice(body);

  // T2/T3: classify the training run from its shape. A massive run is T3 and is
  // offloaded; a small one stays on the local GPU.
  const trainingRoute = classifyLoraTraining({
    samples: plan.brief.samples.length,
    resolution: Number(body.resolution) || 1024,
    networkDim: Number(body.networkDim) || 32,
    epochs: Number(body.epochs) || 10,
  });
  broadcastThought(`[ROUTER] ${trainingRoute.task} → ${trainingRoute.tier} (${trainingRoute.placement})`);
  if (trainingRoute.placement === 'cloud' && !t3LocalAllowed()) {
    const offload = route_to_cloud(trainingRoute.task, { trigger: plan.brief.trigger });
    res.status(503).json({
      error: offload.note,
      code: 'T3_OFFLOAD',
      route: trainingRoute,
      offload,
    });
    return;
  }

  const { images } = await generateLoraImages(plan, body.images !== false, lora);
  if (images.size === 0) {
    res.status(400).json({
      error: 'Walang larawan na na-generate. Magpatakbo ng ComfyUI o mag-enable ng image model bago mag-train.',
    });
    return;
  }

  const id = `${Date.now()}_${plan.brief.trigger}`;
  const runRoot = path.join(RUNS_ROOT, id);
  fs.mkdirSync(runRoot, { recursive: true });
  const outputDir = path.join(status.output_dir, id);

  const config = trainingConfig({
    datasetDir: path.join(runRoot, 'dataset'),
    outputDir,
    outputName: `${toSlug(plan.brief.title)}_${plan.brief.trigger}`,
    baseModel: status.base_model as string,
    resolution: Number(body.resolution) || 1024,
    numRepeats: Number(body.numRepeats) || 10,
    maxEpochs: Number(body.epochs) || 10,
    networkDim: Number(body.networkDim) || 32,
    networkAlpha: Math.round((Number(body.networkDim) || 32) / 2),
    seed: 42,
  });

  const captions = plan.brief.samples.map((s, i) => ({
    name: numberedName(plan.brief.trigger, i),
    text: buildCaption(plan.brief, s),
  }));

  try {
    const job = loraTrainer.start({
      id,
      title: plan.brief.title,
      trigger: plan.brief.trigger,
      root: runRoot,
      captions,
      images,
      config,
      // Make the trained LoRA immediately usable by ComfyUI.
      onArtifact: file => {
        const published = publishLora(file);
        broadcastThought(`[DIREK] LoRA published: ${published.name}`);
      },
    });
    broadcastThought(`[DIREK] Training started: ${job.trigger} (${images.size} images).`);
    res.json({ status: 'started', job: jobSummary() });
  } catch (error: any) {
    res.status(409).json({ error: error?.message || 'Hindi ma-start ang training.' });
  }
});

app.post('/api/direk/train/cancel', (_req: Request, res: Response) => {
  const cancelled = loraTrainer.cancel();
  broadcastThought(cancelled ? '[DIREK] Training cancelled.' : '[DIREK] Walang tumatakbong training.');
  res.json({ cancelled });
});

// Live training log (SSE). EventSource cannot set headers, so the token is
// also accepted as a query parameter by the auth middleware.
app.get('/api/direk/train/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const job = loraTrainer.current();
  if (job) {
    for (const line of job.log.slice(-100)) res.write(`data: ${line}\n\n`);
  }
  const off = loraTrainer.onLine(line => res.write(`data: ${line}\n\n`));
  req.on('close', off);
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
