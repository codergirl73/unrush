import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { UNRUSH_QUIET: "1" },
    include: ["test/**/*.test.ts"],
  },
});
