import test from 'node:test';
import assert from 'node:assert/strict';
import { TEXT_MODEL, IMAGE_MODEL, VIDEO_MODEL, IMAGE_MODEL_FREE, VIDEO_MODEL_FREE, aiUnavailable } from './config';

test('text model is a free-tier model', () => {
  assert.equal(TEXT_MODEL, 'gemini-2.5-flash');
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
