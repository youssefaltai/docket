import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/** Per spec, a relative XDG_* value is invalid and must be ignored. */
function absoluteEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && isAbsolute(value) ? value : undefined;
}

function xdgDataHome(): string {
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
