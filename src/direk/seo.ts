/**
 * Local SEO and metadata generator.
 *
 * This is the free replacement for vidIQ (growth/SEO) and Tracy AI (audience
 * research) from the skill registry. It is deterministic, so it works with no
 * API key: given a title and an optional logline or script, it writes a
 * YouTube/TikTok-ready package.
 */

export interface SeoPack {
  titles: string[];
  description: string;
  tags: string[];
  hashtags: string[];
  chapters: { at: string; label: string }[];
  thumbnailText: string;
}

const HOOKS = ['Sobrang', 'Ang totoong kwento ng', 'Bakit', 'Paano gumawa ng', 'Hindi mo pa alam ang'];
const CTAS = ['I-subscribe para sa susunod na episode.', 'I-like at i-share kung nagustuhan mo.', 'I-comment ang susunod na gusto mong gawin.'];

function clean(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function titleCase(text: string): string {
  return clean(text)
    .split(' ')
    .map(w => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function hashtag(term: string): string {
  const t = term
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join('');
  return t ? `#${t}` : '';
}

function stamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Build the metadata pack. `keywords` are extra terms (genre, cast, mood) used
 * for tags and hashtags.
 */
export function buildSeoPack(
  title: string,
  opts: { logline?: string; keywords?: string[]; durationSeconds?: number; mood?: string } = {},
): SeoPack {
  const base = clean(title) || 'Bagong Pelikula';
  const logline = clean(opts.logline || '');
  const keywords = (opts.keywords || []).map(clean).filter(Boolean);
  const mood = clean(opts.mood || '');

  const titles = [
    base,
    `${base} (${mood ? titleCase(mood) + ' ' : ''}Short Film)`,
    ...HOOKS.slice(0, 3).map(h => `${h} ${base}`),
  ].filter((t, i, arr) => t && arr.indexOf(t) === i).slice(0, 5);

  const firstLine = logline || `${base} — isang orihinal na maikling pelikula.`;
  const cta = CTAS[Math.floor(base.length) % CTAS.length];

  const tagSet = new Set<string>([
    ...keywords,
    ...base.split(/\s+/).filter(w => w.length > 3),
    'short film',
    'pelikulang Pinoy',
    'AI film',
  ]);
  const tags = Array.from(tagSet).map(t => t.toLowerCase()).slice(0, 20);

  const hashtags = Array.from(new Set([...keywords.slice(0, 4), base.split(/\s+/)[0], 'PinoyFilm', 'ShortFilm']
    .map(hashtag)
    .filter(Boolean))).slice(0, 8);

  const duration = opts.durationSeconds && opts.durationSeconds > 0 ? opts.durationSeconds : 0;
  const chapters = duration
    ? [
        { at: '00:00', label: 'Simula' },
        { at: stamp(duration * 0.25), label: 'Pag-usbong ng problema' },
        { at: stamp(duration * 0.6), label: 'Pinakamataas na bahagi' },
        { at: stamp(duration * 0.9), label: 'Katapusan' },
      ]
    : [];

  const description = [
    firstLine,
    '',
    logline ? '' : `Isang orihinal na kwentong gawa ni Direk.`,
    cta,
    '',
    hashtags.join(' '),
  ].filter(line => line !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');

  const thumbnailText = base
    .split(/\s+/)
    .slice(0, 4)
    .join(' ')
    .toUpperCase()
    .slice(0, 30);

  return { titles, description, tags, hashtags, chapters, thumbnailText };
}
