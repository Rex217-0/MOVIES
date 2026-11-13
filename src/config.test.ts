import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TEXT_MODEL, TEXT_MODELS, IMAGE_MODEL, VIDEO_MODEL, IMAGE_MODEL_FREE, VIDEO_MODEL_FREE,
  aiUnavailable, isRetryableModelError,
} from './config';

test('the text models are a non-empty, ordered fallback list', () => {
  assert.ok(TEXT_MODELS.length >= 2, 'needs a fallback');
  assert.equal(TEXT_MODEL, TEXT_MODELS[0]);
  for (const m of TEXT_MODELS) assert.match(m, /^gemini-/);
});

test('retired and rate-limited models are retried, real errors are not', () => {
  assert.equal(isRetryableModelError('models/gemini-2.5-flash is no longer available to new users'), true);
  assert.equal(isRetryableModelError('This model is currently experiencing high demand'), true);
  assert.equal(isRetryableModelError('RESOURCE_EXHAUSTED: 429 rate limit'), true);
  assert.equal(isRetryableModelError('API key not valid. Please pass a valid API key.'), false);
});

test('image and video generation are marked unavailable on the free tier', () => {
  assert.equal(IMAGE_MODEL_FREE, false);
  assert.equal(VIDEO_MODEL_FREE, false);
});

test('image and video models are still identified for the paid path', () => {
  assert.equal(IMAGE_MODEL, 'gemini-2.5-flash-image');
  assert.equal(VIDEO_MODEL, 'gemini-omni-1.2-flash');
});

test('aiUnavailable builds a structured, non-success error', () => {
  const err = aiUnavailable(TEXT_MODEL, 'Set GEMINI_API_KEY.', 'No key configured');
  assert.equal(err.code, 'AI_UNAVAILABLE');
  assert.equal(err.model, TEXT_MODEL);
  assert.match(err.error, /No key configured/);
  assert.match(err.error, /Set GEMINI_API_KEY/);
});
