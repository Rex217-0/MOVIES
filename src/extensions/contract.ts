/**
 * The Extension Contract ("Abang na Bakal").
 *
 * A season upgrade — a harvester, a QC gatekeeper, a scheduler — plugs into the
 * Movie Creator by implementing this one interface. The core app never imports a
 * season's internals; it only knows `MovieCreatorExtension`. That keeps an
 * upgrade removable: disable it and the rest of the app still boots.
 */

/** An Express-shaped app. Typed loosely so the contract stays dependency-free. */
export interface RouteHost {
  get(path: string, handler: (req: any, res: any) => unknown): unknown;
  post(path: string, handler: (req: any, res: any) => unknown): unknown;
}

/**
 * A skill the Director's Chair model may call. `run` does the real work and
 * returns JSON-safe data; the chat endpoint forwards it to the UI.
 */
export interface ExtensionSkill {
  /** Stable id the model writes inside an ```action``` block. */
  id: string;
  /** One line, in Tagalog, telling the model what the skill does. */
  does: string;
  /** The argument shape, shown to the model verbatim. */
  args: string;
  /** True when the skill is destructive enough to need a confirmation. */
  confirm?: boolean;
  run(args: Record<string, unknown>): Promise<unknown>;
}

export interface MovieCreatorExtension {
  /** URL-safe id, e.g. `season-01-harvester`. */
  id: string;
  name: string;
  /** Which season ships this extension. */
  season: number;
  version: string;
  /** A disabled extension is skipped by the registry and never mounts routes. */
  enabled: boolean;
  /** Mount this extension's HTTP routes. Throwing here only disables this one. */
  registerRoutes(app: RouteHost): void;
  skills: ExtensionSkill[];
}

/** A skill that a request asked for and that does not exist. */
export class UnknownSkillError extends Error {
  readonly skill: string;
  constructor(skill: string) {
    super(`Walang skill na '${skill}'.`);
    this.name = 'UnknownSkillError';
    this.skill = skill;
  }
}

/** A skill that exists but whose extension is switched off. */
export class SkillDisabledError extends Error {
  readonly skill: string;
  constructor(skill: string) {
    super(`Naka-off ang extension na may skill na '${skill}'.`);
    this.name = 'SkillDisabledError';
    this.skill = skill;
  }
}
