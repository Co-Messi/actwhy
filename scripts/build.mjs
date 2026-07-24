import { build } from "esbuild";
import { chmodSync } from "node:fs";

const version = process.env.npm_package_version ?? "0.0.0";

await build({
  entryPoints: ["src/cli/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/actwhy.js",
  logLevel: "warning",
  define: { ACTWHY_VERSION: JSON.stringify(version) },
  banner: {
    js: [
      "#!/usr/bin/env node",
      // Some CJS dependencies (yaml) use dynamic require; provide it in ESM.
      "import { createRequire as __actwhyCreateRequire } from 'node:module';",
      "const require = __actwhyCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});

chmodSync("dist/actwhy.js", 0o755);
console.log("built dist/actwhy.js");
