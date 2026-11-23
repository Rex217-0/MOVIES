/**
 * The extension registry. It mounts every enabled extension inside its own
 * try/catch, so a broken season upgrade disables only itself: the app still
 * boots, and `/api/extensions` reports exactly what failed and why.
 */

import {
  SkillDisabledError,
  UnknownSkillError,
  type ExtensionSkill,
  type MovieCreatorExtension,
  type RouteHost,
} from './contract.ts';

export interface ExtensionStatus {
  id: string;
  name: string;
  season: number;
  version: string;
  enabled: boolean;
  /** `mounted` = routes are live; `failed` = it threw while mounting. */
  state: 'mounted' | 'disabled' | 'failed';
  skills: string[];
  error?: string;
}

export class ExtensionRegistry {
  private readonly extensions: MovieCreatorExtension[] = [];
  private readonly statuses = new Map<string, ExtensionStatus>();
  private readonly skills = new Map<string, ExtensionSkill>();
  private mounted = false;

  register(extension: MovieCreatorExtension): void {
    if (this.extensions.some(e => e.id === extension.id)) {
      throw new Error(`May extension nang '${extension.id}'.`);
    }
    this.extensions.push(extension);
    this.statuses.set(extension.id, {
      id: extension.id,
      name: extension.name,
      season: extension.season,
      version: extension.version,
      enabled: extension.enabled,
      state: extension.enabled ? 'failed' : 'disabled',
      skills: extension.skills.map(s => s.id),
    });
  }

  /**
   * Mount every enabled extension. One extension's failure is recorded against
   * that extension alone and never stops the others from mounting.
   */
  mountExtensions(app: RouteHost): ExtensionStatus[] {
    for (const extension of this.extensions) {
      const status = this.statuses.get(extension.id)!;
      if (!extension.enabled) {
        status.state = 'disabled';
        continue;
      }
      try {
        extension.registerRoutes(app);
        status.state = 'mounted';
        delete status.error;
        for (const skill of extension.skills) {
          if (this.skills.has(skill.id)) {
            throw new Error(`Doble ang skill id '${skill.id}'.`);
          }
          this.skills.set(skill.id, skill);
        }
      } catch (error: any) {
        status.state = 'failed';
        status.error = error?.message || String(error);
        // A half-mounted extension must not keep its skills callable.
        for (const skill of extension.skills) this.skills.delete(skill.id);
        console.error(`[EXTENSION] ${extension.id} failed to mount:`, status.error);
      }
    }
    this.mounted = true;
    return this.getExtensionsStatus();
  }

  getExtensionsStatus(): ExtensionStatus[] {
    return this.extensions.map(e => ({ ...this.statuses.get(e.id)!, skills: [...this.statuses.get(e.id)!.skills] }));
  }

  /** Every skill from every mounted extension, for the model's action list. */
  skillCatalog(): { id: string; does: string; args: string }[] {
    return [...this.skills.values()].map(s => ({ id: s.id, does: s.does, args: s.args }));
  }

  hasSkill(id: string): boolean {
    return this.skills.has(id);
  }

  /**
   * Run one extension skill. Throws `UnknownSkillError` when nothing registers
   * the id, and `SkillDisabledError` when an extension that owns it is off.
   */
  async runExtensionSkill(id: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const skill = this.skills.get(id);
    if (skill) return skill.run(args);

    const owner = this.extensions.find(e => e.skills.some(s => s.id === id));
    if (owner) throw new SkillDisabledError(id);
    throw new UnknownSkillError(id);
  }

  get isMounted(): boolean {
    return this.mounted;
  }
}

/** The registry the app mounts once at boot. */
export const extensionRegistry = new ExtensionRegistry();
