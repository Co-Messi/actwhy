import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // @actions/workflow-parser imports a JSON schema without import
    // attributes; inlining lets vite transform it for node.
    server: {
      deps: {
        inline: ["@actions/workflow-parser", "@actions/expressions"],
      },
    },
  },
});
