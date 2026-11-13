/**
 * The Direk production pipeline, from idea to publish.
 * Ported from the persona pipeline in direk/persona.py.
 */

export interface PipelineStage {
  id: string;
  name: string;
  description: string;
}

export const PIPELINE: PipelineStage[] = [
  { id: 'IDEYA', name: 'Ideya', description: 'Logline at konsepto ng pelikula.' },
  { id: 'SCRIPT', name: 'Script', description: 'Synopsis, script, dialogue, scene list.' },
  { id: 'KARAKTER', name: 'Karakter', description: 'Character bible: itsura, ugali, boses.' },
  { id: 'SHOT_LIST', name: 'Shot List', description: 'Shot list at storyboard prompts bawat eksena.' },
  { id: 'VISUAL', name: 'Visual', description: 'Image / video prompt bawat shot (image-to-video).' },
  { id: 'EDIT', name: 'Edit', description: 'Editing, color, sound, at short clips.' },
  { id: 'PUBLISH', name: 'Publish', description: 'Poster, SEO, at pag-publish.' },
];

/**
 * Skill id that drives each stage. `null` means the stage is handled by the
 * model's own writing (a local skill).
 */
export const STAGE_SKILL: Record<string, string | null> = {
  IDEYA: null,
  SCRIPT: 'write_script',
  KARAKTER: 'character_bible',
  SHOT_LIST: 'shot_list',
  VISUAL: 'ai_video_prompt',
  EDIT: 'media_edit',
  PUBLISH: 'publish_post',
};
