/**
 * The quality contract: what a render is, and what a tier is allowed to accept.
 *
 * These tests pin the rule the canary needs: a MASTER job must never receive a
 * still-motion clip, and the refusal must be a checkable state rather than a
 * log line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptsMediaClass, enginesForTier, mediaClassForEngine, parseQualityTier,
  requiresMasterBackend, masterBackendBlockedDetail, BLOCKED_MASTER_BACKEND,
  MASTER_BACKEND_UNAVAILABLE_CODE, QUALITY_TIERS, MEDIA_CLASSES, TIER_ACCEPTS,
  type MediaClass, type QualityTier,
} from './mediaClass.ts';

test('each engine maps to the media class it really produces', () => {
  assert.equal(mediaClassForEngine('comfyui'), 'SYNTHETIC_MOTION');
  assert.equal(mediaClassForEngine('wan'), 'SYNTHETIC_MOTION');
  // The free engine is a still picture panned by ffmpeg. It is a real MP4 and a
  // real fallback, but it is not a generative render, and the class must say so.
  assert.equal(mediaClassForEngine('motion'), 'STILL_MOTION');
  assert.equal(mediaClassForEngine('stock'), 'STOCK_FOOTAGE');
});

test('an unknown engine is a failure, never a silent synthetic claim', () => {
  assert.equal(mediaClassForEngine('some-new-engine'), 'FAILED');
  assert.equal(mediaClassForEngine(''), 'FAILED');
});

test('hybrid is only reported when the caller says two sources were combined', () => {
  assert.equal(mediaClassForEngine('comfyui', { hybrid: true }), 'HYBRID');
  // A single engine is never upgraded to hybrid on its own.
  assert.equal(mediaClassForEngine('stock', { hybrid: false }), 'STOCK_FOOTAGE');
});

test('CANARY and PREVIEW accept still motion; MASTER refuses it', () => {
  assert.equal(acceptsMediaClass('CANARY', 'STILL_MOTION').accepted, true);
  assert.equal(acceptsMediaClass('PREVIEW', 'STILL_MOTION').accepted, true);
  assert.equal(acceptsMediaClass('MASTER', 'STILL_MOTION').accepted, false);
});

test('MASTER accepts only a synthetic render', () => {
  assert.equal(acceptsMediaClass('MASTER', 'SYNTHETIC_MOTION').accepted, true);
  assert.equal(acceptsMediaClass('MASTER', 'STOCK_FOOTAGE').accepted, false);
  assert.equal(acceptsMediaClass('MASTER', 'HYBRID').accepted, false);
  assert.equal(acceptsMediaClass('MASTER', 'FAILED').accepted, false);
});

test('a refused class is blocked, not merely failed, and says why', () => {
  const verdict = acceptsMediaClass('MASTER', 'STILL_MOTION');
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.tier, 'MASTER');
  assert.equal(verdict.mediaClass, 'STILL_MOTION');
  assert.match(verdict.reason, /STILL_MOTION/);
  assert.match(verdict.reason, /ken-burns/);
  assert.match(verdict.reason, /MASTER/);
});

test('an accepted clip carries no refusal text', () => {
  const verdict = acceptsMediaClass('MASTER', 'SYNTHETIC_MOTION');
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.blocked, false);
  assert.equal(verdict.reason, '');
});

test('a MASTER job never even tries the still-motion engine', () => {
  assert.deepEqual(enginesForTier('MASTER').sort(), ['comfyui', 'wan']);
  // The free tiers may use every engine, which is what makes them cheap.
  for (const tier of ['CANARY', 'PREVIEW'] as QualityTier[]) {
    assert.ok(enginesForTier(tier).includes('motion'), `${tier} should allow motion`);
  }
});

test('every tier accepts at least one engine, so no tier is impossible', () => {
  for (const tier of QUALITY_TIERS) {
    assert.ok(enginesForTier(tier).length > 0, `${tier} has no usable engine`);
  }
});

test('every media class is described by every tier, with no gap', () => {
  for (const tier of QUALITY_TIERS) {
    const accepts = TIER_ACCEPTS[tier];
    assert.ok(accepts.length > 0);
    for (const cls of accepts) assert.ok(MEDIA_CLASSES.includes(cls));
  }
  // MASTER is exactly one class, which is the whole point of the tier.
  assert.deepEqual(TIER_ACCEPTS.MASTER, ['SYNTHETIC_MOTION']);
});

test('requiresMasterBackend is true only for MASTER', () => {
  assert.equal(requiresMasterBackend('MASTER'), true);
  assert.equal(requiresMasterBackend('CANARY'), false);
  assert.equal(requiresMasterBackend('PREVIEW'), false);
});

test('an unknown or misspelled tier falls back to CANARY, never to MASTER', () => {
  assert.equal(parseQualityTier('master'), 'MASTER');
  assert.equal(parseQualityTier(' MASTER '), 'MASTER');
  assert.equal(parseQualityTier('preview'), 'PREVIEW');
  assert.equal(parseQualityTier(undefined), 'CANARY');
  assert.equal(parseQualityTier(''), 'CANARY');
  assert.equal(parseQualityTier('MASTERR'), 'CANARY');
  assert.equal(parseQualityTier(null), 'CANARY');
});

test('the block detail names the tier, the requirement and the way out', () => {
  const detail = masterBackendBlockedDetail('ComfyUI unreachable');
  assert.ok(detail.startsWith(BLOCKED_MASTER_BACKEND));
  assert.match(detail, /ComfyUI unreachable/);
  assert.match(detail, /Hindi ito bababa sa STILL_MOTION/);
  // It must not suggest the exact substitution the policy forbids.
  assert.doesNotMatch(detail, /motion engine ang gagamitin/);
});

test('the block codes are stable strings the API and the DB agree on', () => {
  assert.equal(MASTER_BACKEND_UNAVAILABLE_CODE, 'REQUIRED_MASTER_BACKEND_UNAVAILABLE');
  assert.ok(BLOCKED_MASTER_BACKEND.startsWith('BLOCKED:'));
  assert.ok(BLOCKED_MASTER_BACKEND.endsWith(MASTER_BACKEND_UNAVAILABLE_CODE));
});

test('every media class has a defined meaning, and FAILED is refused everywhere', () => {
  for (const cls of MEDIA_CLASSES) {
    assert.equal(typeof cls, 'string');
  }
  for (const tier of QUALITY_TIERS) {
    assert.equal(acceptsMediaClass(tier, 'FAILED' as MediaClass).accepted, false);
  }
});
