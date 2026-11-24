import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeTranscript, toPayload } from './chatTurns.ts';

test('a restored transcript is used when nothing was typed yet', () => {
  const saved = [
    { role: 'user' as const, content: 'horror sa probinsya' },
    { role: 'assistant' as const, content: 'gaano katagal?' },
  ];
  assert.deepEqual(mergeTranscript(saved, []), saved);
});

test('a message typed while hydration was in flight is kept alongside it', () => {
  const saved = [
    { role: 'user' as const, content: 'Luma: horror' },
    { role: 'assistant' as const, content: 'gaano katagal?' },
  ];
  const local = [{ role: 'user' as const, content: 'BAGO: comedy sa Maynila' }];
  assert.deepEqual(mergeTranscript(saved, local), [
    { role: 'user', content: 'Luma: horror' },
    { role: 'assistant', content: 'gaano katagal?' },
    { role: 'user', content: 'BAGO: comedy sa Maynila' },
  ]);
});

test('an empty restore leaves the session turns untouched', () => {
  const local = [{ role: 'user' as const, content: 'una kong mensahe' }];
  assert.deepEqual(mergeTranscript([], local), local);
});

test('the payload carries the whole transcript, so the model keeps context', () => {
  const turns = [
    { role: 'user' as const, content: 'Luma: horror, 3 minuto' },
    { role: 'assistant' as const, content: 'Anong mood?' },
    { role: 'user' as const, content: 'madilim' },
    { role: 'user' as const, content: 'gawin mong comedy' },
  ];
  assert.deepEqual(toPayload(turns), [
    { role: 'user', content: 'Luma: horror, 3 minuto' },
    { role: 'assistant', content: 'Anong mood?' },
    { role: 'user', content: 'madilim' },
    { role: 'user', content: 'gawin mong comedy' },
  ]);
});

test('a failed turn is not replayed to the router as assistant content', () => {
  const turns = [
    { role: 'user' as const, content: 'horror' },
    { role: 'assistant' as const, content: 'AI_UNAVAILABLE', error: 'AI_UNAVAILABLE' },
    { role: 'user' as const, content: 'subukan ulit' },
  ];
  assert.deepEqual(toPayload(turns), [
    { role: 'user', content: 'horror' },
    { role: 'user', content: 'subukan ulit' },
  ]);
});

test('a first message is sent alone when there is no history yet', () => {
  assert.deepEqual(toPayload([{ role: 'user' as const, content: 'una kong mensahe' }]), [
    { role: 'user', content: 'una kong mensahe' },
  ]);
});
