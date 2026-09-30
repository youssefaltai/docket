// Prints a one-time sign-in link for a person, for when they (say, the only admin) can't sign in anywhere.
// Usage on the server: bun run sign-in-link <username> [workspace]   (in Docker: docker compose exec docket bun run sign-in-link …)
// Usernames are per workspace: if several people hold it, name the workspace. Shell access to the server is
// the proof of identity, so this has no HTTP route.
import { recoverySignInLink } from "../src/server/access.ts";
import { AppError } from "../src/server/db.ts";

const [username, workspace] = process.argv.slice(2);
if (!username) {
  console.error("Usage: bun run sign-in-link <username> [workspace]");
  process.exit(2);
}
try {
  const { code, expiresAt } = recoverySignInLink(username, workspace);
  const origin = (process.env.DOCKET_URL || `http://localhost:${process.env.PORT || 7100}`).replace(/\/+$/, "");
  console.log(`${origin}/login#${code}`);
  console.log(`One-time link for ${username}, valid until ${expiresAt}.`);
} catch (err) {
  console.error((err as Error).message);
  if (err instanceof AppError && err.status === 409) console.error(`Run: bun run sign-in-link ${username} <workspace>`);
  process.exit(1);
}
