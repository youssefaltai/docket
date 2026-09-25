// Prints a one-time sign-in link for a person, for when they (say, the only admin) can't sign in anywhere.
// Usage on the server: bun run sign-in-link <username>   (in Docker: docker compose exec docket bun run sign-in-link <username>)
// Shell access to the server is the proof of identity, so this has no HTTP route.
import "../src/server/config.ts";
import { recoverySignInLink } from "../src/server/access.ts";

const username = process.argv[2];
if (!username) {
  console.error("Usage: bun run sign-in-link <username>");
  process.exit(2);
}
try {
  const { code, expiresAt } = recoverySignInLink(username);
  const origin = (process.env.DOCKET_URL ?? `http://localhost:${process.env.PORT ?? 7100}`).replace(/\/+$/, "");
  console.log(`${origin}/login#${code}`);
  console.log(`One-time link for ${username}, valid until ${expiresAt}.`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
