/**
 * The official MCP Apps view runtime (@modelcontextprotocol/ext-apps `App`), inlined
 * into each UI resource so the HTML is self-contained (hosts render it in a
 * sandboxed iframe with no network access to our server). The bundle's trailing
 * `export{a as B,…}` is rewritten to `globalThis.McpApps={B:a,…}` so a plain inline
 * module can use it.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

let cached: string | undefined;

export function appRuntimeScript(): string {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const src = readFileSync(require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8");
  const m = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(src);
  if (!m) throw new Error("Unexpected ext-apps bundle format: no trailing export list");
  const entries = m[1]!
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [local, exported] = s.split(/\s+as\s+/);
      return `${JSON.stringify(exported ?? local)}:${local}`;
    });
  cached = `${src.slice(0, m.index)}\nglobalThis.McpApps={${entries.join(",")}};`;
  // `</script>` inside the bundle would end the inline script early.
  cached = cached.replace(/<\/script/gi, "<\\/script");
  return cached;
}
