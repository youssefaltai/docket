// Fills a running Docket with demo data over REST, for development and screenshots.
// Usage: bun run seed [url]   (default http://localhost:7100; DOCKET_TOKEN is sent if set). Empty Dockets only.
// Only goes through the public API, so it keeps working whatever happens inside the server.

const url = process.argv[2] ?? "http://localhost:7100";
const token = process.env.DOCKET_TOKEN;

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(new URL(path, url), {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.error}`);
  return data;
}

// The default URL is also where a real Docket runs, so never write into one that has data.
if ((await api("GET", "/api/projects")).length > 0) {
  console.error(`${url} has data; seed only runs against an empty Docket`);
  process.exit(1);
}

await api("POST", "/api/workspaces", { key: "demo", name: "Demo" });
await api("POST", "/api/projects", {
  key: "WEB",
  workspace: "demo",
  name: "Website",
  description: "Marketing site and docs",
});
await api("POST", "/api/projects", { key: "APP", workspace: "demo", name: "Mobile app" });

const issue = (project: string, title: string, fields: Record<string, unknown> = {}) =>
  api("POST", "/api/issues", { project, title, ...fields });
const comment = (id: string, author: string, body: string) =>
  api("POST", `/api/issues/${id}/comments`, { author, body });

await issue("WEB", "Redesign the landing page", {
  status: "in_progress",
  priority: 2,
  labels: ["design"],
  assignee: "alex",
  description: "Lead with the product screenshot. Keep it to one screen on mobile.",
});
await issue("WEB", "Write hero copy", { status: "done", priority: 3, parent: "WEB-1", assignee: "claude" });
await issue("WEB", "Export new screenshots", { status: "todo", priority: 3, parent: "WEB-1", blockedBy: ["WEB-2"] });
await issue("WEB", "Fix broken links in the docs", {
  status: "in_review",
  priority: 1,
  labels: ["bug", "docs"],
  assignee: "claude",
});
await issue("WEB", "Add a dark theme", { status: "backlog", priority: 4, labels: ["design"] });
await issue("WEB", "Drop the old pricing page", { status: "canceled" });

await issue("APP", "Offline mode for the issue list", { status: "todo", priority: 2, labels: ["feature"] });
await issue("APP", "Crash when opening a deleted issue", {
  status: "in_progress",
  priority: 1,
  labels: ["bug"],
  assignee: "claude",
});
await issue("APP", "Push notifications", { status: "backlog", labels: ["feature"] });

await comment("WEB-1", "alex", "Mockups are in Figma. @claude can you draft the copy?");
await comment("WEB-2", "claude", "Drafted three headline options in [Landing copy](/doc/landing-copy). Going with the second.");
await comment("WEB-4", "claude", "Found 12 broken links, fixed all but two that point to removed pages. Moved to review.");
await comment("APP-2", "claude", "Reproduced: the detail view assumes the issue still exists. Adding a not-found state.");

await api("POST", "/api/documents", {
  project: "WEB",
  title: "Landing copy",
  author: "claude",
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
  project: "APP",
  title: "Offline plan",
  author: "alex",
  content: `# Offline plan

Cache the last-opened issues and docs (APP-1). Handle deleted ones gracefully (APP-2).
`,
});

console.log(`Seeded ${url}: workspace "demo" with 2 projects, 9 issues and 2 docs.`);
