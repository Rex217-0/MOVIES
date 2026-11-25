/**
 * Multi-shot planning: how one scene becomes several shots.
 *
 * A generated clip is a few seconds long; a scene is minutes long. The old way
 * to bridge that gap was to loop ONE clip until the scene ended, so a five
 * minute scene was the same five seconds repeated sixty times. This module
 * splits the scene into distinct shots instead, each with its own camera
 * framing and its own render prompt, so the picture keeps moving and the film
 * reads as a sequence rather than a stutter.
 *
 * The planning is pure and deterministic: given a scene and a duration it
 * returns the shots to render, in order. That keeps it unit-testable without a
 * GPU, an ffmpeg, or a network call.
 */

import type { MediaClass } from './mediaClass.ts';

/** How a shot frames its subject. Each one becomes a different prompt. */
export type ShotFraming = 'establishing' | 'wide' | 'medium' | 'close' | 'detail' | 'reaction';

/**
 * The shots a scene is cut into, in camera order. A scene holds a wide to set
 * the place, a medium to carry the action and a close to carry the feeling;
 * a longer scene gets the fuller arc. The list is deliberately short: every
 * extra shot is another GPU render, and more shots of the same moment is not
 * more story.
 */
export const SHOT_ARCS: ShotFraming[][] = [
  ['medium'],
  ['wide', 'close'],
  ['establishing', 'medium', 'close'],
  ['establishing', 'wide', 'medium', 'close'],
  ['establishing', 'wide', 'medium', 'detail', 'close'],
  ['establishing', 'wide', 'medium', 'detail', 'reaction', 'close'],
];

/**
 * The shortest a shot may be before it reads as a flash frame. Below this the
 * shot is folded into its neighbour rather than rendered.
 */
export const MIN_SHOT_SECONDS = 2;

/**
 * What each framing asks the model for, appended to the scene's visual line.
 * These describe camera position, not the subject: the subject comes from the
 * scene, so two shots of the same scene differ in framing, not in content.
 */
export const FRAMING_PROMPTS: Record<ShotFraming, string> = {
  establishing: 'extreme wide establishing shot, the whole location visible, camera still',
  wide: 'wide shot, subject small in frame, environment dominant',
  medium: 'medium shot, subject centered, waist up, slow push in',
  close: 'close-up shot, face fills the frame, shallow depth of field',
  detail: 'extreme close-up detail shot of hands and objects, no face',
  reaction: 'medium close-up, subject reacting, slight handheld movement',
};

export interface PlannedShot {
  /** 1-based position in the scene, matching the shot's order in the film. */
  index: number;
  framing: ShotFraming;
  /** Seconds this shot must cover on the timeline. */
  seconds: number;
  /** The render prompt: the scene's visual line plus this shot's framing. */
  prompt: string;
}

/**
 * The most shots one scene may be cut into. Coverage beyond this is another
 * render each, and a film of 18 scenes at six shots apiece is 108 GPU renders
 * for one feature — more time than the extra angles are worth. A film that
 * wants that density should say so, not get it by default.
 */
export const MAX_SHOTS_PER_SCENE = Number.isFinite(Number(process.env?.DIREK_MAX_SHOTS))
  ? Math.max(1, Number(process.env.DIREK_MAX_SHOTS))
  : 6;

/**
 * Choose the shot arc for a duration.
 *
 * What this does NOT do, and cannot: make a 300 second scene out of 5 second
 * renders without repeating them. At six shots a scene that is ten repeats per
 * shot, and no arrangement of ffmpeg fixes it — only a longer render does. What
 * the cut does buy is that the picture changes framing six times instead of
 * holding one shot for five minutes, which is the difference between a montage
 * and a freeze. `repeatFactor` reports the number so the cost is visible
 * instead of hidden inside a `-stream_loop -1`.
 */
export function arcFor(seconds: number): ShotFraming[] {
  const len = Math.max(1, Math.round(seconds));
  const base = len <= 6 ? 0 : len <= 12 ? 1 : len <= 20 ? 2 : len <= 32 ? 3 : len <= 45 ? 4 : 5;
  return SHOT_ARCS[Math.min(SHOT_ARCS[base].length, MAX_SHOTS_PER_SCENE) - 1];
}

/**
 * How many times a render of `renderSeconds` must play to cover `slotSeconds`.
 * Exposed so the job can report it and refuse an absurd fill.
 */
export function repeatFactor(slotSeconds: number, renderSeconds: number): number {
  if (renderSeconds <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.ceil(slotSeconds / renderSeconds));
}

/**
 * Split `seconds` into `count` parts whose sum is exactly `seconds`, giving the
 * remainder to the first parts so no frame is lost to rounding. Every part is
 * at least MIN_SHOT_SECONDS, so a caller asking for too many shots for the time
 * available gets fewer shots, not flash frames.
 */
export function splitSeconds(seconds: number, count: number): number[] {
  const parts = Math.max(1, Math.min(count, Math.floor(seconds / MIN_SHOT_SECONDS)));
  const base = Math.floor((seconds / parts) * 100) / 100;
  const out = new Array(parts).fill(base);
  let remainder = Math.round((seconds - base * parts) * 100) / 100;
  for (let i = 0; i < out.length && remainder > 0; i++) {
    const add = Math.min(0.01, remainder);
    out[i] = Math.round((out[i] + add) * 100) / 100;
    remainder = Math.round((remainder - add) * 100) / 100;
  }
  return out;
}

/**
 * Plan the shots for one scene. Deterministic: the same scene and duration
 * always plan the same shots, so a re-render resumes the same coverage instead
 * of silently producing a different film.
 */
export function planSceneShots(
  opts: { visual: string; heading: string; seconds: number },
): PlannedShot[] {
  const subject = (opts.visual || opts.heading).trim().replace(/\.$/, '');
  const arc = arcFor(opts.seconds);
  const lengths = splitSeconds(opts.seconds, arc.length);
  return lengths.map((seconds, i) => {
    const framing = arc[i];
    return {
      index: i + 1,
      framing,
      seconds,
      prompt: `${subject}. ${FRAMING_PROMPTS[framing]}.`,
    };
  });
}

/**
 * The class of a whole scene built from several shots.
 *
 * A scene cut from mixed sources is HYBRID, not whichever class happened to
 * land first: calling a stock+generated sequence "SYNTHETIC_MOTION" would let a
 * MASTER job accept a scene it should have refused. An empty list is FAILED.
 */
export function sceneMediaClass(classes: MediaClass[]): MediaClass {
  const present = classes.filter(c => c !== 'FAILED');
  if (!present.length) return 'FAILED';
  const unique = new Set(present);
  if (unique.size === 1) return present[0];
  // STILL_MOTION mixed with real motion is still not real motion on its own,
  // so the strictest class wins over HYBRID for tier purposes.
  if (unique.has('SYNTHETIC_MOTION') && unique.has('STILL_MOTION')) return 'HYBRID';
  return 'HYBRID';
}

/** One line for the thought stream: what the scene was actually cut into. */
export function shotPlanSummary(shots: PlannedShot[]): string {
  return shots
    .map(s => `${s.framing} ${s.seconds.toFixed(1)}s`)
    .join(' → ');
}
