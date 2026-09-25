// Side effect only: loads an optional XDG config file into process.env.
// Imported first (see index.ts) so every other module sees the resulting env.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { xdgConfigDirs, xdgConfigHome } from "./paths.ts";

function applyConfigFile(path: string) {
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    // Real env vars win over the config file.
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const candidates = [xdgConfigHome(), ...xdgConfigDirs()].map((dir) => join(dir, "docket", "config"));
const configPath = candidates.find(existsSync);
if (configPath) applyConfigFile(configPath);
