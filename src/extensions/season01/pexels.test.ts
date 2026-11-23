import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  buildSearchUrl,
  parseCandidates,
  searchHeaders,
  harvestSourcesFor,
  HARVEST_SOURCES,
  type HarvestSource,
} from './loraHarvester.ts';
import {
  pickPexels4kFile,
  searchPexelsBroll,
  pexelsVideoBase,
} from '../../direk/stockVideo.ts';

/**
 * The Pexels upgrade. `buildSearchUrl` and `parseCandidates` are pure, and
 * `searchPexelsBroll` is exercised against a real local HTTP server so the
 * query params, the auth header and the 4K file choice are all proven.
 */

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const keys = Object.keys(env);
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]!;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!;
      }
    });
}

test('Pexels joins the rotation only when a key is present', async () => {
  assert.deepEqual(harvestSourcesFor(false), HARVEST_SOURCES);
  assert.equal(harvestSourcesFor(false).includes('pexels'), false);
  assert.deepEqual(harvestSourcesFor(true), ['pexels', ...HARVEST_SOURCES]);
  assert.equal(harvestSourcesFor(true)[0], 'pexels', 'Pexels is tried first when available');
});

test('the photo search asks for landscape, large, and 24 per page', () => {
  const url = new URL(buildSearchUrl('pexels', 'https://api.pexels.com/v1/search', 'foggy mountain'));
  assert.equal(url.searchParams.get('query'), 'foggy mountain');
  assert.equal(url.searchParams.get('orientation'), 'landscape');
  assert.equal(url.searchParams.get('size'), 'large');
  assert.equal(url.searchParams.get('per_page'), '24');
});

test('the other mines keep their own query shape', () => {
  const wall = new URL(buildSearchUrl('wallhaven', 'https://wallhaven.cc/api/v1/search', 'neon'));
  assert.equal(wall.searchParams.get('q'), 'neon');
  assert.equal(wall.searchParams.get('atleast'), '1280x720');
  assert.equal(wall.searchParams.get('orientation'), null, 'no Pexels params leak in');
});

test('Pexels sends the key bare in Authorization, not as a bearer token', () => {
  return withEnv({ PEXELS_API_KEY: 'pex-key-123' }, () => {
    const headers = searchHeaders('pexels');
    assert.equal(headers.Authorization, 'pex-key-123');
    assert.equal(headers['User-Agent'], undefined, 'Pexels does not need a UA');

    const wall = searchHeaders('wallhaven');
    assert.equal(wall.Authorization, undefined, 'no key is sent to the keyless mines');
    assert.match(String(wall['User-Agent']), /MovieCreator/);
  });
});

test('parsing a Pexels photo prefers src.original and keeps the credit', () => {
  const payload = {
    photos: [
      {
        id: 1,
        width: 6000,
        height: 4000,
        url: 'https://www.pexels.com/photo/fog-1/',
        photographer: 'Juan dela Cruz',
        photographer_url: 'https://www.pexels.com/@juan',
        src: {
          original: 'https://images.pexels.com/photos/1/original.jpg',
          large: 'https://images.pexels.com/photos/1/large.jpg',
        },
      },
    ],
  };

  const [hit] = parseCandidates('pexels', payload, 'fog');
  assert.ok(hit, 'one candidate came back');
  assert.equal(hit!.url, 'https://images.pexels.com/photos/1/original.jpg');
  assert.equal(hit!.width, 6000);
  assert.equal(hit!.height, 4000);
  assert.equal(hit!.photographer, 'Juan dela Cruz');
  assert.equal(hit!.photographerUrl, 'https://www.pexels.com/@juan');
  assert.equal(hit!.page, 'https://www.pexels.com/photo/fog-1/');
});

test('a Pexels photo with no original is skipped, not saved broken', () => {
  const payload = { photos: [{ id: 2, src: { large: 'https://images.pexels.com/2/large.jpg' } }] };
  assert.deepEqual(parseCandidates('pexels', payload, 'x'), []);
});

test('an empty Pexels reply is an empty list, not a crash', () => {
  assert.deepEqual(parseCandidates('pexels', {}, 'x'), []);
  assert.deepEqual(parseCandidates('pexels', { photos: [] }, 'x'), []);
});

test('pickPexels4kFile chooses the 4K file over the smaller ones', () => {
  const files = [
    { id: 1, quality: 'sd', file_type: 'video/mp4', width: 640, height: 360, link: 'a' },
    { id: 2, quality: 'hd', file_type: 'video/mp4', width: 1920, height: 1080, link: 'b' },
    { id: 3, quality: 'uhd', file_type: 'video/mp4', width: 3840, height: 2160, link: 'c' },
  ];
  assert.equal(pickPexels4kFile(files)!.link, 'c');
});

test('pickPexels4kFile falls back to the widest when no true 4K exists', () => {
  const files = [
    { id: 1, quality: 'sd', file_type: 'video/mp4', width: 640, height: 360, link: 'a' },
    { id: 2, quality: 'qhd', file_type: 'video/mp4', width: 2560, height: 1440, link: 'b' },
  ];
  assert.equal(pickPexels4kFile(files)!.link, 'b');
});

test('pickPexels4kFile ignores non-MP4 files and an empty list', () => {
  assert.equal(pickPexels4kFile([]), null);
  assert.equal(
    pickPexels4kFile([{ id: 1, quality: 'uhd', file_type: 'video/webm', width: 3840, height: 2160, link: 'x' }]),
    null,
  );
});

/** A real HTTP stand-in for the Pexels video search endpoint. */
async function fakePexels(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void>; seen: string[] }> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? 'none'}`);
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test('searchPexelsBroll returns 4K landscape clips with full credit', async () => {
  const fake = await fakePexels((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      videos: [
        {
          id: 77,
          url: 'https://www.pexels.com/video/rain-77/',
          duration: 12,
          user: { name: 'Maria Santos', url: 'https://www.pexels.com/@maria' },
          video_files: [
            { id: 1, quality: 'hd', file_type: 'video/mp4', width: 1920, height: 1080, link: 'https://cdn/1080.mp4' },
            { id: 2, quality: 'uhd', file_type: 'video/mp4', width: 3840, height: 2160, link: 'https://cdn/2160.mp4' },
          ],
        },
      ],
    }));
  });

  try {
    await withEnv({ PEXELS_API_KEY: 'pex-key-abc', PEXELS_VIDEO_BASE: `${fake.url}/v1/videos/search` }, async () => {
      const clips = await searchPexelsBroll('rain on window', { minSeconds: 5 });
      assert.equal(clips.length, 1);
      const clip = clips[0]!;
      assert.equal(clip.link, 'https://cdn/2160.mp4', 'the 4K file was chosen');
      assert.equal(clip.width, 3840);
      assert.equal(clip.duration, 12);
      assert.equal(clip.photographer, 'Maria Santos');
      assert.equal(clip.photographerUrl, 'https://www.pexels.com/@maria');
      assert.equal(clip.pageUrl, 'https://www.pexels.com/video/rain-77/');

      // The request itself must ask for landscape + large and carry the key.
      const sent = fake.seen[0]!;
      assert.match(sent, /orientation=landscape/);
      assert.match(sent, /size=large/);
      assert.match(sent, /auth=pex-key-abc/);
    });
  } finally {
    await fake.close();
  }
});

test('searchPexelsBroll filters out clips shorter than minSeconds', async () => {
  const fake = await fakePexels((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      videos: [
        {
          id: 1, url: 'p1', duration: 2, user: { name: 'A' },
          video_files: [{ id: 1, quality: 'uhd', file_type: 'video/mp4', width: 3840, height: 2160, link: 'x' }],
        },
      ],
    }));
  });
  try {
    await withEnv({ PEXELS_API_KEY: 'k', PEXELS_VIDEO_BASE: `${fake.url}/v` }, async () => {
      assert.deepEqual(await searchPexelsBroll('x', { minSeconds: 5 }), []);
    });
  } finally {
    await fake.close();
  }
});

test('searchPexelsBroll returns an empty list with no key, without a request', async () => {
  const fake = await fakePexels((_req, res) => res.end('{}'));
  try {
    await withEnv({ PEXELS_API_KEY: undefined, PEXELS_VIDEO_BASE: `${fake.url}/v` }, async () => {
      assert.deepEqual(await searchPexelsBroll('x'), []);
      assert.equal(fake.seen.length, 0, 'no key means no request at all');
    });
  } finally {
    await fake.close();
  }
});

test('searchPexelsBroll surfaces an HTTP failure instead of pretending it is empty', async () => {
  const fake = await fakePexels((_req, res) => {
    res.statusCode = 429;
    res.end('{"error":"rate limit"}');
  });
  try {
    await withEnv({ PEXELS_API_KEY: 'k', PEXELS_VIDEO_BASE: `${fake.url}/v` }, async () => {
      await assert.rejects(() => searchPexelsBroll('x'), /Pexels video search HTTP 429/);
    });
  } finally {
    await fake.close();
  }
});

test('the video endpoint defaults to the official Pexels URL', async () => {
  await withEnv({ PEXELS_VIDEO_BASE: undefined }, () => {
    assert.equal(pexelsVideoBase(), 'https://api.pexels.com/v1/videos/search');
  });
});

test('HarvestSource still accepts the original three mines', () => {
  // A compile-time guard: the union was widened, not replaced.
  const sources: HarvestSource[] = ['wallhaven', 'openverse', 'wikimedia', 'pexels'];
  assert.equal(new Set(sources).size, 4);
});
