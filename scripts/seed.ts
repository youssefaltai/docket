// Fills a running Docket with demo data over REST, for development and screenshots.
// Usage: DOCKET_API_KEY=dk_... bun run seed   (default url http://localhost:7100; set DOCKET_URL to override).
// Only goes through the public API, so it keeps working whatever happens inside the server.

const url = process.env.DOCKET_URL ?? "http://localhost:7100";
const token = process.env.DOCKET_API_KEY;

if (!token) {
  console.error("Set DOCKET_API_KEY to an API key (create one in Settings), e.g. DOCKET_API_KEY=dk_... bun run seed");
  process.exit(1);
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(new URL(path, url), {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error}`);
  return data;
}

const me = await api("GET", "/api/me");
const workspace = me.workspaces[0]?.key;
if (!workspace) throw new Error(`${url}: caller has no workspace`);

// Never write into a Docket that has data.
if ((await api("GET", "/api/teams")).length > 0) {
  console.error(`${url} has data; seed only runs against an empty Docket`);
  process.exit(1);
}

await api("POST", "/api/teams", { key: "WEB", workspace, name: "Website" });
await api("POST", "/api/teams", { key: "APP", workspace, name: "Mobile app" });

const issue = (team: string, title: string, fields: Record<string, unknown> = {}) =>
  api("POST", "/api/issues", { team, title, ...fields });
const comment = (id: string, body: string) => api("POST", `/api/issues/${id}/comments`, { body });

await issue("WEB", "Redesign the landing page", {
  status: "in_progress",
  priority: 2,
  labels: ["design"],
  assignee: "me",
  description: "Lead with the product screenshot. Keep it to one screen on mobile.",
});
await issue("WEB", "Write hero copy", { status: "done", priority: 3, parent: "WEB-1", assignee: "me" });
await issue("WEB", "Export new screenshots", { status: "todo", priority: 3, parent: "WEB-1", blockedBy: ["WEB-2"] });
await issue("WEB", "Fix broken links in the docs", {
  status: "in_review",
  priority: 1,
  labels: ["bug", "docs"],
  assignee: "me",
});
await issue("WEB", "Add a dark theme", { status: "backlog", priority: 4, labels: ["design"] });
await issue("WEB", "Drop the old pricing page", { status: "canceled" });

await issue("APP", "Offline mode for the issue list", { status: "todo", priority: 2, labels: ["feature"] });
await issue("APP", "Crash when opening a deleted issue", {
  status: "in_progress",
  priority: 1,
  labels: ["bug"],
  assignee: "me",
});
await issue("APP", "Push notifications", { status: "backlog", labels: ["feature"] });

await comment("WEB-1", "Mockups are in Figma. @claude can you draft the copy?");
await comment("WEB-2", "Drafted three headline options in [Landing copy](/doc/landing-copy). Going with the second.");
await comment("WEB-4", "Found 12 broken links, fixed all but two that point to removed pages. Moved to review.");
await comment("APP-2", "Reproduced: the detail view assumes the issue still exists. Adding a not-found state.");

await api("POST", "/api/documents", {
  team: "WEB",
  title: "Landing copy",
  content: `# Landing copy

For WEB-1, drafted in WEB-2.

## Headline options

1. Ship faster with fewer tabs open
2. **The tracker your agents can use** (chosen)
3. Issues, boards and docs in one place

## Next

Screenshots are tracked in WEB-3.
`,
});
await api("POST", "/api/documents", {
  team: "APP",
  title: "Offline plan",
  content: `# Offline plan

Cache the last-opened issues and docs (APP-1). Handle deleted ones gracefully (APP-2).
`,
});

console.log(`Seeded ${url}: workspace "${workspace}" with 2 teams, 9 issues and 2 docs.`);
