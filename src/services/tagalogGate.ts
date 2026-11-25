/**
 * The Tagalog screenplay gate, in the app itself.
 *
 * The same four signals the Kaggle notebook uses (scripts/direk_tagalog_worker.ipynb),
 * because the notebook is not the only thing that writes screenplays. The local
 * provider path (Gemini, Claude, DeepSeek, Pollinations, Ollama) called
 * `writeScreenplay` directly and never ran a gate at all, so a 38%-repetitive
 * script — measured, from a real free-model run — reached the film factory and
 * answered HTTP 200. The notebook's gate cannot help there: it runs on Kaggle,
 * in another process, on another machine.
 *
 * Kept in step with the notebook on purpose. The signals are:
 *   1. Repeated 3-grams. Real garbage repeats 27-38% of its phrases; a clean
 *      screenplay repeats ~1-5%.
 *   2. Invented hyphenated words, strict in both directions: "bahay-kubo" and
 *      "unti-unting" are real, "pagkakaiba-biba" is not.
 *   3. Too few function words (ang, ng, sa, si, ay) for the word count.
 *   4. Shape: EKSENA/SCENE headings with VISUAL and NARRATION nested under them,
 *      plus a PAMAGAT. A well-written essay is still not a screenplay.
 */

export interface ScreenplayShape {
  eksena: number;
  visual: number;
  narration: number;
  pamagat: number;
}

export interface ScreenplayReport {
  ok: boolean;
  score: number;
  issues: string[];
  shape: ScreenplayShape;
}

const FUNCTION_WORDS = new Set([
  'ang', 'ng', 'sa', 'si', 'ni', 'kay', 'na', 'ay', 'mga', 'at',
  'siya', 'niya', 'kaniya', 'ko', 'mo', 'namin', 'natin', 'sila', 'nila',
  'ito', 'iyan', 'iyon', 'may', 'mayroon', 'para', 'dahil', 'kung',
  'ako', 'ikaw', 'kami', 'tayo', 'hindi', 'oo', 'din', 'rin', 'lang',
]);

const PREFIXES = new Set([
  'nag', 'mag', 'pag', 'ka', 'ma', 'pa', 'na', 'um', 'in', 'i', 'ipa',
  'maki', 'paki', 'taga', 'palang', 'pinaka', 'sang', 'tig',
]);

const WORD_RE = /[A-Za-zÑñÁáÉéÍíÓóÚú'-]+/g;
const TERMINAL = new Set(['.', '!', '?', '"', "'", ')']);
const SCENE_RE = /\b(?:EKSENA|SCENE)\s*\d+/i;
const MARKDOWN_RE = /^[\s>*_#`\-\u2022]+|[*_`]+$/g;

export const MIN_SCENES = 3;
export const MIN_TAGALOG_SCORE = Number(process.env.TAGALOG_MIN_SCORE || 55);

function tokens(text: string): string[] {
  return (text || '').match(WORD_RE)?.map(w => w.toLowerCase()) ?? [];
}

function sentences(text: string): string[] {
  return (text || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** Invented hyphenated words. Real reduplication and real compounds pass. */
export function reduplicationErrors(text: string): string[] {
  const bad: string[] = [];
  for (const word of tokens(text)) {
    if (!word.includes('-')) continue;
    const parts = word.split('-');
    if (parts.some(p => PREFIXES.has(p))) continue;
    if (parts.length !== 2) continue;
    const [left, right] = parts;
    if (!left || !right) continue;
    if (left === right) {
      if (left.length > 6) bad.push(word);
      continue;
    }
    // A linker adds one or two letters: "unti-unting", "dahan-dahang".
    if (right.startsWith(left) && right.length - left.length > 0 && right.length - left.length <= 2) {
      continue;
    }
    if (right.length >= 4 && left.endsWith(right.slice(-3))) {
      bad.push(word);
      continue;
    }
    if (commonPrefix(left, right) >= 4 && Math.abs(left.length - right.length) <= 3) {
      bad.push(word);
    }
  }
  return bad;
}

/** Repeated n-grams, and how many there were to repeat. */
export function repeatedPhrases(text: string, n = 3): { repeated: number; grams: number } {
  const words = tokens(text);
  if (words.length < n) return { repeated: 0, grams: 0 };
  const counts = new Map<string, number>();
  for (let i = 0; i <= words.length - n; i++) {
    const key = words.slice(i, i + n).join(' ');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let repeated = 0;
  for (const c of counts.values()) if (c > 1) repeated += c - 1;
  return { repeated, grams: words.length - n + 1 };
}

/** Strip presentation so "### **Eksena 1**" reads as a scene heading. */
function normalizeLine(line: string): string {
  return line.trim().replace(MARKDOWN_RE, '').replace(/^[*_`\s]+|[*_`\s]+$/g, '');
}

/** Count the shape the app needs: scenes, each with VISUAL and NARRATION. */
export function screenplayShape(text: string): ScreenplayShape {
  const shape: ScreenplayShape = { eksena: 0, visual: 0, narration: 0, pamagat: 0 };
  if (!text) return shape;
  let inScene = false;
  for (const line of text.split('\n')) {
    const upper = normalizeLine(line).toUpperCase();
    if (!upper) continue;
    if (SCENE_RE.test(upper)) {
      shape.eksena++;
      inScene = true;
      continue;
    }
    if (upper.startsWith('PAMAGAT')) {
      shape.pamagat++;
      inScene = false;
      continue;
    }
    if (inScene && upper.startsWith('VISUAL')) shape.visual++;
    else if (inScene && upper.startsWith('NARRATION')) shape.narration++;
  }
  return shape;
}

/** Language quality on its own: score 0-100 and every problem found. */
export function tagalogReport(text: string): { score: number; issues: string[] } {
  const issues: string[] = [];
  const lines = sentences(text);
  const words = tokens(text);
  if (words.length === 0) return { score: 0, issues: ['walang nilalaman'] };

  const { repeated, grams } = repeatedPhrases(text);
  const repeatRatio = grams ? repeated / grams : 0;
  if (repeatRatio > 0.02) {
    issues.push(`paulit-ulit na parirala (${Math.round(repeatRatio * 100)}% ng mga 3-gram)`);
  }

  const invented = reduplicationErrors(text);
  if (invented.length > 0) {
    issues.push(`gawa-gawang salita: ${[...new Set(invented)].sort().slice(0, 5).join(', ')}`);
  }

  const functionRatio = words.filter(w => FUNCTION_WORDS.has(w)).length / words.length;
  if (words.length >= 20 && functionRatio < 0.15) {
    issues.push(`kakaunti ang pantulong na salita (${Math.round(functionRatio * 100)}%)`);
  }

  const truncated = lines.length > 0 && !TERMINAL.has(lines[lines.length - 1].slice(-1));
  if (truncated) issues.push('hindi natapos ang huling pangungusap');

  let score = 100;
  score -= Math.min(70, Math.round(repeatRatio * 250));
  score -= Math.min(45, invented.length * 25);
  if (words.length >= 20 && functionRatio < 0.15) score -= 20;
  if (truncated) score -= 10;
  return { score: Math.max(0, score), issues };
}

/**
 * The whole verdict: is this a screenplay the factory can film?
 *
 * Truncation blocks rather than merely deducting: a film that stops mid-sentence
 * is a broken film, and a real free-model answer ended on a comma while still
 * clearing the score threshold.
 */
export function screenplayReport(text: string, minScenes = MIN_SCENES): ScreenplayReport {
  const { score, issues } = tagalogReport(text);
  const shape = screenplayShape(text);
  const problems: string[] = [];

  if (shape.eksena < minScenes) problems.push(`${shape.eksena} eksena lang (kailangan ${minScenes}+)`);
  if (shape.visual < shape.eksena) problems.push(`kulang ang VISUAL (${shape.visual}/${shape.eksena})`);
  if (shape.narration < shape.eksena) problems.push(`kulang ang NARRATION (${shape.narration}/${shape.eksena})`);
  if (shape.pamagat === 0) problems.push('walang PAMAGAT');
  if (issues.includes('hindi natapos ang huling pangungusap')) problems.push('putol ang screenplay sa dulo');

  return {
    ok: problems.length === 0 && score >= MIN_TAGALOG_SCORE,
    score,
    issues: [...issues, ...problems],
    shape,
  };
}
