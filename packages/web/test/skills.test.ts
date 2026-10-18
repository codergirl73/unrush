/**
 * Agent Skills: SKILL.md discovery and validation, progressive disclosure through
 * load_skill, and activation of the evening-rescue skill on proactive turns.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContentBlock, ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { openDb } from "../../mcp-server/src/db.js";
import { startServer, type RunningServer } from "../../mcp-server/src/index.js";
import { seedDemo } from "../../mcp-server/src/seed.js";
import { fixedClock } from "../../mcp-server/src/time.js";
import type { ConverseClient } from "../server/agent.js";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { McpBridge } from "../server/mcpBridge.js";
import { EVENING_RESCUE, loadSkills, parseFrontMatter, runLoadSkill, skillsCatalog } from "../server/skills.js";

const H = "demo-household";
const TODAY = "2026-10-23";
const dir = mkdtempSync(join(tmpdir(), "unrush-skills-"));
let mcp: RunningServer;
let bridge: McpBridge;

beforeAll(async () => {
  const clock = fixedClock(`${TODAY}T15:00`);
  const dbPath = join(dir, "u.db");
  const db = openDb(dbPath);
  seedDemo(db, H, { clock });
  db.close();
  mcp = await startServer({ port: 0, dbPath, proactiveIntervalMs: 0, unrush: { clock } });
  bridge = new McpBridge(mcp.url, H, () => {});
  await bridge.connect();
});

afterAll(async () => {
  await bridge?.close();
  await mcp?.close();
  rmSync(dir, { recursive: true, force: true });
});

function recordingModel(turns: Array<{ content: ContentBlock[]; stopReason: string }>) {
  const requests: Array<{ system: string; tools: string[]; lastUser: unknown }> = [];
  let i = 0;
  const client: ConverseClient = {
    send: (async (cmd: ConverseCommand) => {
      requests.push({
        system: cmd.input.system?.[0]?.text ?? "",
        tools: (cmd.input.toolConfig?.tools ?? []).map((t) => t.toolSpec!.name!),
        lastUser: cmd.input.messages?.at(-1)?.content?.[0],
      });
      const t = turns[Math.min(i++, turns.length - 1)]!;
      return { output: { message: { role: "assistant", content: t.content } }, stopReason: t.stopReason, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, metrics: { latencyMs: 1 }, $metadata: {} } as ConverseCommandOutput;
    }) as ConverseClient["send"],
  };
  return { client, requests };
}

describe("SKILL.md discovery", () => {
  it("loads the repo's evening-rescue skill with valid front matter", () => {
    const skills = loadSkills();
    const s = skills.find((x) => x.name === EVENING_RESCUE)!;
    expect(s.description).toMatch(/calendar change/);
    expect(s.metadata).toMatchObject({ author: "unrush", version: "1.0" });
    expect(s.body).toMatch(/^# Evening rescue/);
    expect(s.body).not.toContain("---");
    expect(skillsCatalog(skills)).toContain(`- ${EVENING_RESCUE}: Rescue a household evening`);
  });

  it("rejects skills whose name doesn't match the folder or lack a description", () => {
    const d = mkdtempSync(join(tmpdir(), "skills-bad-"));
    mkdirSync(join(d, "good-name"));
    writeFileSync(join(d, "good-name", "SKILL.md"), "---\nname: other-name\ndescription: x\n---\nbody");
    expect(() => loadSkills(d)).toThrow(/must equal the folder name/);
    writeFileSync(join(d, "good-name", "SKILL.md"), "---\nname: good-name\n---\nbody");
    expect(() => loadSkills(d)).toThrow(/description is required/);
    expect(() => parseFrontMatter("no front matter")).toThrow(/front matter/);
    rmSync(d, { recursive: true, force: true });
  });

  it("load_skill returns instructions or a referenced file, and refuses path escapes", () => {
    const skills = loadSkills();
    expect(runLoadSkill(skills, { name: EVENING_RESCUE }).text).toMatch(/Shall I place the order\?/);
    expect(runLoadSkill(skills, { name: EVENING_RESCUE, path: "references/consent.md" }).text).toMatch(/Three independent locks/);
    expect(runLoadSkill(skills, { name: EVENING_RESCUE, path: "../../package.json" }).ok).toBe(false);
    expect(runLoadSkill(skills, { name: "nope" }).text).toMatch(/Available: unrush-evening-rescue/);
  });
});

describe("skills at runtime", () => {
  it("activates evening-rescue on proactive turns; chat turns get the catalog + load_skill", async () => {
    const { client, requests } = recordingModel([
      { stopReason: "tool_use", content: [{ toolUse: { toolUseId: "s1", name: "load_skill", input: { name: EVENING_RESCUE } as never } }] },
      { stopReason: "end_turn", content: [{ text: "Leave by 7:05." }] },
    ]);
    const config = { ...loadConfig({}), mcpUrl: mcp.url, householdId: H, region: "us-east-1", modelId: "m" };
    const app = createApp({ config, bridge, model: client, log: () => {} });

    await bridge.read("add_or_update_event", {
      event: { id: "evt-project-sync", title: "Project sync", start: `${TODAY}T17:30`, end: `${TODAY}T19:00`, location: "Online" },
    });
    await app.pollAlerts();
    expect(requests[0]!.system).toContain(`ACTIVE SKILL: ${EVENING_RESCUE}`);
    expect(requests[0]!.system).toContain("## 2. Fix dinner if it no longer fits");
    expect(requests[0]!.tools).toContain("load_skill");
    expect(requests[0]!.tools).toContain("compute_leave_by");
    // The model's load_skill call was answered locally with the playbook.
    const result = (requests[1]!.lastUser as { toolResult: { content: Array<{ json: { instructions: string } }> } }).toolResult;
    expect(result.content[0]!.json.instructions).toMatch(/# Evening rescue/);
  });
});
