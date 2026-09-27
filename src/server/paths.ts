import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/** Per spec, a relative XDG_* value is invalid and must be ignored. */
function absoluteEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && isAbsolute(value) ? value : undefined;
}

export function xdgDataHome(): string {
  return absoluteEnv("XDG_DATA_HOME") ?? join(homedir(), ".local", "share");
}

/** The SQLite database: DATABASE_PATH, else $XDG_DATA_HOME/docket/docket.db. */
export function databasePath(): string {
  return process.env.DATABASE_PATH ?? join(xdgDataHome(), "docket", "docket.db");
}

/** Uploaded files, next to the database (/app/data/attachments in Docker), one file per attachment id. */
export function attachmentsDir(): string {
  return join(dirname(databasePath()), "attachments");
}

export function xdgConfigHome(): string {
  return absoluteEnv("XDG_CONFIG_HOME") ?? join(homedir(), ".config");
}

/** Ordered, most to least preferred. Defaults to /etc/xdg per spec. */
export function xdgConfigDirs(): string[] {
  const dirs = (process.env.XDG_CONFIG_DIRS ?? "").split(":").filter(isAbsolute);
  return dirs.length > 0 ? dirs : ["/etc/xdg"];
}
