import test from 'node:test';
import assert from 'node:assert/strict';
import { 
  evaluateDirectiveHazard, 
  calculateVitals, 
  parsePilotResponse,
  validateVideoAspectRatio,
  validateImageEditInput,
  buildTacticalVideoPrompt, buildVeoStylePrompt, buildVeoStyleNegative,
  applyAssetReview,
  VideoAsset
} from './rules';

test('hazard evaluation triggers on strike directives without confirmation', () => {
  const result = evaluateDirectiveHazard('Initiate orbital kinetic strike on hostile cruiser', false);
  assert.equal(result.isHazardous, true);
  assert.equal(result.actionCode, 'AUTHORIZE_KINETIC_STRIKE');
});

test('hazard evaluation passes when confirmed is true', () => {
  const result = evaluateDirectiveHazard('Initiate orbital kinetic strike on hostile cruiser', true);
  assert.equal(result.isHazardous, false);
  assert.equal(result.actionCode, 'CONFIRMED');
});

test('hazard evaluation passes for benign directives', () => {
  const result = evaluateDirectiveHazard('Perform diagnostic radar sweep on sector 9', false);
  assert.equal(result.isHazardous, false);
  assert.equal(result.actionCode, 'STANDARD_EXECUTION');
});

test('hazard evaluation catches safety and protocol overrides', () => {
  const result = evaluateDirectiveHazard('Safemed override bypass safety controls', false);
  assert.equal(result.isHazardous, true);
  assert.equal(result.actionCode, 'PROTOCOL_SAFETY_OVERRIDE');
});

test('calculateVitals produces valid numeric bounds', () => {
  const vitals = calculateVitals(150, 8);
  assert.equal(typeof vitals.latency_ms, 'number');
  assert.equal(vitals.latency_ms, 150);
  assert.ok(vitals.tokens_per_sec >= 18.5);
});

test('parsePilotResponse handles valid JSON and markdown fences', () => {
  const validJson = JSON.stringify({
    intent: 'SCAN_COMPLETE',
    action: 'RADAR_ARRAY_POINTED',
    analysis: 'Sensors detected no hostiles in perimeter.',
  });
  const parsed = parsePilotResponse(validJson);
  assert.equal(parsed.intent, 'SCAN_COMPLETE');
  assert.equal(parsed.status, 'success');

  const fenced = '```json\n{"intent": "VECTOR_OPTIMIZED", "action": "THRUST_ALIGNED"}\n```';
  const parsedFenced = parsePilotResponse(fenced);
  assert.equal(parsedFenced.intent, 'VECTOR_OPTIMIZED');
});

test('validateVideoAspectRatio restricts to 16:9 or 9:16', () => {
  assert.equal(validateVideoAspectRatio('16:9'), '16:9');
  assert.equal(validateVideoAspectRatio('9:16'), '9:16');
  assert.equal(validateVideoAspectRatio('4:3'), '16:9');
  assert.equal(validateVideoAspectRatio(undefined), '16:9');
});

test('validateImageEditInput requires both prompt and image data', () => {
  assert.equal(validateImageEditInput('', 'test prompt').valid, false);
  assert.equal(validateImageEditInput('data:image/png;base64,abc', '').valid, false);
  assert.equal(validateImageEditInput('data:image/png;base64,abc', 'enhance contrast').valid, true);
});

test('buildTacticalVideoPrompt appends sci-fi style modifiers when missing', () => {
  const enhanced = buildTacticalVideoPrompt('Drone flying through city');
  assert.ok(enhanced.includes('Drone flying through city'));
  assert.ok(enhanced.includes('cinematic tactical HUD'));
});

test('buildVeoStylePrompt adds camera, lighting and film look when missing', () => {
  const out = buildVeoStylePrompt('A fisherman on a boat');
  assert.ok(out.startsWith('A fisherman on a boat'));
  assert.match(out, /camera/i);
  assert.match(out, /light/i);
  assert.match(out, /35mm|photoreal/i);
});

test('buildVeoStylePrompt leaves a prompt that already specifies everything alone', () => {
  const given = 'A wide aerial shot of a city at sunset, neon lighting, cinematic 35mm film';
  assert.equal(buildVeoStylePrompt(given), given);
});

test('buildVeoStylePrompt trims and collapses whitespace, and handles empty input', () => {
  assert.equal(buildVeoStylePrompt('   '), '');
  assert.ok(!buildVeoStylePrompt('  a cat  ').startsWith(' '));
  assert.ok(!buildVeoStylePrompt('a cat.').includes('cat.'));
});

test('buildVeoStyleNegative names common artifacts', () => {
  assert.match(buildVeoStyleNegative(), /blurry/);
  assert.match(buildVeoStyleNegative(), /watermark/);
});

test('applyAssetReview properly updates reviewStatus', () => {
  const mockAssets: VideoAsset[] = [
    { id: 'v-1', title: 'Orbital Jump', url: 'https://video.mp4', status: 'completed', reviewStatus: 'pending', createdAt: '2026-11-12T00:00:00Z' },
    { id: 'v-2', title: 'Drone Sweep', url: 'https://video.mp4', status: 'completed', reviewStatus: 'pending', createdAt: '2026-11-12T00:00:00Z' },
  ];

  const approved = applyAssetReview(mockAssets, 'v-1', 'approve');
  assert.equal(approved.find(a => a.id === 'v-1')?.reviewStatus, 'approved');
  assert.equal(approved.find(a => a.id === 'v-2')?.reviewStatus, 'pending');

  const rejected = applyAssetReview(mockAssets, 'v-2', 'reject');
  assert.equal(rejected.find(a => a.id === 'v-2')?.reviewStatus, 'rejected');
});


