#!/usr/bin/env node
"use strict";

import { build } from "esbuild";
import { copyFileSync } from "fs";

build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  tsconfig: "tsconfig.json",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  watch: process.argv.includes("--watch"),
  minify: process.argv.includes("--minify"),
  sourcemap: process.argv.includes("--sourcemap"),
  sourcesContent: process.argv.includes("--sources-content"),
  logLevel: "info",
})
  .then(() => {
    copyFileSync("node_modules/source-map/lib/mappings.wasm", "dist/mappings.wasm");
  })
  .catch((err) => {
    console.log(err);
    process.exit(1);
  });
