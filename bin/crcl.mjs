#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ext = process.platform === "win32" ? ".exe" : "";
const bin = path.join(__dirname, "native", `crcl${ext}`);

if (!existsSync(bin)) {
  await import("./install.js");
}
const result = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
