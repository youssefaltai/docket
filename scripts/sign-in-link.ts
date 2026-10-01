// Prints a one-time sign-in link for a person, for when they (say, the only admin) can't sign in anywhere.
// Usage on the server: bun run sign-in-link <username> [workspace]   (in Docker: docker compose exec docket bun run sign-in-link …)
// On Workers, from anywhere: ADMIN_TOKEN=… DOCKET_URL=https://… bun run sign-in-link <username> [workspace]
// (with the ADMIN_TOKEN secret set on the Worker). Usernames are per workspace: if several people hold it, name the
// workspace. Shell access to the server (or the Worker's admin token) is the proof of identity, so this has no public route.
const [username, workspace] = process.argv.slice(2);
if (!username) {
  console.error("Usage: bun run sign-in-link <username> [workspace]");
  process.exit(2);
}
const origin = (process.env.DOCKET_URL || `http://localhost:${process.env.PORT || 7100}`).replace(/\/+$/, "");
const token = process.env.ADMIN_TOKEN;

async function link(): Promise<{ code: string; expiresAt: string } | { error: string; status: number }> {
  if (token) {
    const res = await fetch(`${origin}/api/admin/sign-in-link`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ username, workspace }),
    });
    return res.ok ? res.json() : { error: ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`, status: res.status };
  }
  await import("../src/server/local.ts"); // the database
  const { recoverySignInLink } = await import("../src/server/access.ts");
  const { AppError } = await import("../src/server/db.ts");
  try {
    return recoverySignInLink(username!, workspace);
  } catch (err) {
    if (err instanceof AppError) return { error: err.message, status: err.status };
    throw err;
  }
}

const result = await link();
if ("error" in result) {
  console.error(result.error);
  if (result.status === 409) console.error(`Run: bun run sign-in-link ${username} <workspace>`);
  process.exit(1);
}
console.log(`${origin}/login#${result.code}`);
console.log(`One-time link for ${username}, valid until ${result.expiresAt}.`);
