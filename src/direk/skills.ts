/**
 * Skill registry and the ```action``` block parser.
 * Ported from direk/skills.py.
 *
 * Local skills are executed by the model inside its own answer. API skills are
 * surfaced to the caller as a structured "action" object that an orchestrator
 * (the web UI, a workflow, a human) can run later.
 */

export interface SkillSpec {
  kind: 'local' | 'api';
  connector?: string;
  confirm?: boolean;
}

export const SKILLS: Record<string, SkillSpec> = {
  write_script: { kind: 'local' },
  shot_list: { kind: 'local' },
  character_bible: { kind: 'local' },
  ai_video_prompt: { kind: 'local' },
  image_assets: { kind: 'api', connector: 'Cloudinary' },
  media_edit: { kind: 'api', connector: 'Picsart Media Studio' },
  poster_design: { kind: 'api', connector: 'Orshot' },
  video_edit: { kind: 'api', connector: 'Descript' },
  short_clips: { kind: 'api', connector: 'OpusClip' },
  auto_producer: { kind: 'api', connector: 'AI Producer by OpusClip' },
  motion_video: { kind: 'api', connector: 'HyperFrames by HeyGen' },
  screen_demo: { kind: 'api', connector: 'Tella' },
  growth_seo: { kind: 'api', connector: 'vidIQ' },
  audience_research: { kind: 'api', connector: 'Tracy AI Interviewer' },
  cloud_storage: { kind: 'api', connector: 'Google Drive' },
  publish_post: { kind: 'api', connector: 'OpusClip/vidIQ/Tella', confirm: true },
  delete_asset: { kind: 'api', connector: 'Cloudinary/Drive', confirm: true },
};

export interface SkillAction {
  skill: string;
  connector: string;
  args: Record<string, unknown>;
  needs_confirm: boolean;
  status: 'needs_confirm' | 'not_connected';
}

const ACTION_RE = /```action\s*([\s\S]*?)```/;

/** Split a model reply into `[cleanText, action, error]`. */
export function extractAction(text: string): [string, SkillAction | null, string | null] {
  const source = text || '';
  const match = ACTION_RE.exec(source);
  if (!match) return [source.trim(), null, null];

  const clean = source.replace(match[0], '').trim();
  let payload: any;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    return [clean, null, 'Sira ang format ng action.'];
  }

  const name = payload?.skill;
  const spec = SKILLS[name];
  if (!spec) return [clean, null, `Walang skill na '${name}'.`];
  if (spec.kind === 'local') return [clean, null, null];

  return [
    clean,
    {
      skill: name,
      connector: spec.connector!,
      args: payload.args ?? {},
      needs_confirm: Boolean(spec.confirm),
      status: spec.confirm ? 'needs_confirm' : 'not_connected',
    },
    null,
  ];
}
