/**
 * Agent Skills (the open SKILL.md format, agentskills.io) loaded at runtime.
 *
 * - Discovery: every skills/<name>/SKILL.md in the repo; YAML front matter must have
 *   `name` (matching the folder) and `description`.
 * - Progressive disclosure: the system prompt lists each skill's name + description;
 *   the model calls the `load_skill` tool to read the full instructions (or a file
 *   under the skill's references/).
 * - Activation: proactive turns activate the evening-rescue skill directly, so its
 *   playbook is always loaded when Unrush speaks first.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool as BedrockTool, ToolConfiguration } from "@aws-sdk/client-bedrock-runtime";
import type { ToolCallOutcome } from "./mcpBridge.js";

export const SKILLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../skills");
export const EVENING_RESCUE = "unrush-evening-rescue";

export interface Skill {
  name: string;
  description: string;
  dir: string;
  /** SKILL.md body without the front matter. */
  body: string;
  metadata: Record<string, string>;
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Minimal YAML front matter parser: top-level `key: value` pairs plus one level of nested maps. */
export function parseFrontMatter(text: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("SKILL.md must start with YAML front matter between --- lines");
  const data: Record<string, string> = {};
  let parent: string | null = null;
  for (const line of m[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const kv = /^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, indent, key, raw] = kv as unknown as [string, string, string, string];
    const value = raw.replace(/^["']|["']$/g, "");
    if (!indent && !value) parent = key;
    else if (indent && parent) data[`${parent}.${key}`] = value;
    else {
      parent = null;
      data[key] = value;
    }
  }
  return { data, body: m[2]!.trim() };
}

export function loadSkills(dir = SKILLS_DIR): Skill[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => statSync(join(dir, d)).isDirectory() && existsSync(join(dir, d, "SKILL.md")))
    .sort()
    .map((d) => {
      const { data, body } = parseFrontMatter(readFileSync(join(dir, d, "SKILL.md"), "utf8"));
      if (data.name !== d || !NAME_RE.test(d)) throw new Error(`Skill "${d}": front matter name must equal the folder name (lowercase, hyphens).`);
      if (!data.description) throw new Error(`Skill "${d}": description is required.`);
      const metadata = Object.fromEntries(Object.entries(data).filter(([k]) => k.startsWith("metadata.")).map(([k, v]) => [k.slice(9), v]));
      return { name: d, description: data.description, dir: join(dir, d), body, metadata };
    });
}

/** The catalog section of the system prompt (names + descriptions only). */
export function skillsCatalog(skills: Skill[]): string {
  if (!skills.length) return "";
  return [
    "SKILLS",
    "Other skills you can load with load_skill when a request matches:",
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join("\n");
}

/** Full instructions of an activated skill, for the system prompt. */
export function activeSkillBlock(skill: Skill): string {
  return `ACTIVE SKILL: ${skill.name}\n${skill.body}`;
}

export const LOAD_SKILL_TOOL: BedrockTool = {
  toolSpec: {
    name: "load_skill",
    description:
      "Load the full instructions of one of your skills (listed under SKILLS in the system prompt), or a file it references, e.g. path 'references/consent.md'.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name, e.g. unrush-evening-rescue" },
          path: { type: "string", description: "Optional file inside the skill folder, e.g. references/consent.md" },
        },
        required: ["name"],
      } as never,
    },
  },
};

export function runLoadSkill(skills: Skill[], input: Record<string, unknown>): ToolCallOutcome {
  const skill = skills.find((s) => s.name === input.name);
  if (!skill) {
    const text = `Unknown skill "${String(input.name)}". Available: ${skills.map((s) => s.name).join(", ") || "none"}.`;
    return { ok: false, text, data: { error: text } };
  }
  if (typeof input.path === "string" && input.path.trim()) {
    const file = normalize(join(skill.dir, input.path));
    if (!file.startsWith(skill.dir + sep) || !existsSync(file) || !statSync(file).isFile()) {
      const text = `No file "${input.path}" in skill ${skill.name}.`;
      return { ok: false, text, data: { error: text } };
    }
    const content = readFileSync(file, "utf8");
    return { ok: true, text: content, data: { skill: skill.name, path: input.path, content } };
  }
  return { ok: true, text: skill.body, data: { skill: skill.name, instructions: skill.body } };
}

/** Wraps the MCP bridge so the model sees MCP tools + load_skill as one tool set. */
export function withSkills<T extends { toolConfig(): ToolConfiguration; callTool(name: string, input?: Record<string, unknown>): Promise<ToolCallOutcome> }>(
  bridge: T,
  skills: Skill[],
) {
  return {
    toolConfig(): ToolConfiguration {
      const base = bridge.toolConfig();
      return skills.length ? { ...base, tools: [...(base.tools ?? []), LOAD_SKILL_TOOL] } : base;
    },
    async callTool(name: string, input: Record<string, unknown> = {}): Promise<ToolCallOutcome> {
      return name === "load_skill" ? runLoadSkill(skills, input) : bridge.callTool(name, input);
    },
  };
}
