## Why

Code for Docket issues lives in GitHub, often written by agents, but the tracker never hears about it: people copy identifiers by hand, and issues stay "In Progress" after the PR merged. Linear's GitHub integration links PRs to issues by identifier and moves them along; Docket can do the core of it with one signed incoming webhook and no dependencies.

## Linear's behaviour

- "Copy git branch name" (Cmd/Ctrl+Shift+.) gives a branch with the issue ID; the format is a workspace setting: https://linear.app/docs/gitlab , https://linear.app/docs/github-integration
- A PR links when its branch name or title contains the ID, or its description has a magic word + ID (`Fixes ENG-123`, several allowed: "Fixes ENG-123, DES-5 and ENG-256"): https://linear.app/docs/gitlab
- Closing words: close(s/d/ing), fix(es/ed/ing), resolve(s/d/ing), complete(s/d/ing), implement(s/ed/ing). Contributing words (link, never close): ref, references, part of, related to, contributes to, towards, updates: https://linear.app/docs/gitlab
- Default automation: linked issues move to In Progress when PRs open and Done when they merge; configurable per event (drafted, opened, review requested, merged); an issue doesn't close until all its linked PRs are merged/closed: https://linear.app/docs/gitlab
- Linked PRs are listed on the issue: https://linear.app/docs/gitlab

**Deliberate differences.** Fixed automation, no settings: a draft moves unstarted issues to in_progress, an opened or ready PR moves them to **in_review** (in Docket the agent already moved it to in_progress by claiming; a PR is the review step), merge moves to done. No GitHub App or token: Docket only receives webhooks, so no linkback comments on GitHub and no PR details beyond the payload. Branch format is fixed: `username/key-number-title`.

## Where things are today

- `src/server/auth.ts:20-27` `hostAllowed` (private), `135-151` `open` (public JSON route wrapper), `153-181` `authRoutes`: the pattern for a public, credential-less route. `src/server/index.ts:47-48` registers auth and API routes; `/api/*` (`src/server/api.ts:233`) is guarded, so a public route must be registered explicitly.
- `src/server/http.ts:61-75` `http()` (1 MB body cap, per-caller rate limit).
- `src/server/tracker.ts:563-607` `updateIssue(a, id, patch)`: the public way to change status as an actor (with DKT-9 it records history, with DKT-11/DKT-12 it notifies and reports).
- `src/server/access.ts:123-132` `insertUser`, `136-137` `addMember`, `169-184` `actorFor` (private), `260-274` `activeMemberId` (delegate validation), `665-675` member rows, `739-778` agents (create, rotate, remove).
- `src/server/db.ts:257-265` `slugify` (private).
- `src/web/issue.tsx:199-215` issue header (Copy ID button), `236` Docs section; `src/web/pickers.tsx:229-234` `useMembers`; `src/web/settings.tsx:386-403`, `467-528` (Agents).

## Design

### Rules that apply
Linear's features, nano implementation, **no dependencies** (`node:crypto` HMAC). Append the next migration (additive) + survival test. SPEC.md, README and types.ts in the same branch. Connecting is admin + browser session only (it mints a secret). Every change the integration makes goes through `tracker.updateIssue` as its own actor, so history, notifications, webhooks and realtime just work. Branch `feature/github`; tests/typecheck pass; merge, delete branch.

### The GitHub actor
Connecting creates an **agent account in the workspace**, name "GitHub", username `github` (deduped `github-2`… while usernames are global), with no API key. Changes it makes show as "GitHub moved from In Progress to In Review". It is marked as an integration: `WorkspaceMember.integration: boolean`; it can't be delegated to (`activeMemberId` → 400 "github is an integration"), gets no token (`rotateAgentToken` → 400), and is removed by disconnecting, not "Remove agent". Pickers (`useMembers`) skip it; Settings → Agents lists it with "GitHub integration" and no menu. access.ts gains `ensureIntegrationAgent(workspace, username, name): number` (create the account and membership, or reinstate it) and `integrationActor(userId): Actor` (`actorFor` with scope `write`, no session or key); `member` rows compute `integration` as `EXISTS (SELECT 1 FROM github_integrations g WHERE g.user_id = u.id)`.

### Schema (append the next migration)
```sql
CREATE TABLE github_integrations (
  workspace TEXT PRIMARY KEY REFERENCES workspaces(key) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),  -- the GitHub agent account
  secret TEXT,                                    -- verifies X-Hub-Signature-256 (needed in the clear); NULL: disconnected
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE issue_links (
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pull_request', 'commit')),
  title TEXT NOT NULL,               -- PR title, or the commit's first line
  number INTEGER,                    -- PR number
  state TEXT,                        -- PRs: draft | open | merged | closed
  closes INTEGER NOT NULL,           -- 1: closing link (branch, title or closing word); 0: contributing
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (issue_id, url)
);
```

### Contract (`types.ts`)
```ts
export interface IssueLink { url: string; kind: "pull_request" | "commit"; title: string; number: number | null;
  state: "draft" | "open" | "merged" | "closed" | null; closes: boolean; createdAt: string; updatedAt: string }
// Issue gains: branchName: string; links: IssueLink[]   // branchName is for the caller
// WorkspaceMember gains: integration: boolean
export interface GitHubConnection { connected: boolean; url: string; account: UserRef | null } // url: the payload URL
```

### Branch name
`getIssue` sets `branchName = "<username>/<key lowercased>-<number>[-<slug>]"` for the caller: slug = `slugify(title)` (export it from db.ts) cut at a dash to ≤ 40 characters, omitted when empty (Arabic titles); username made ref-safe (runs of `.` collapsed, a trailing `.` or `.lock` replaced with `-`). `youssef/dkt-12-fix-login`.

### Incoming webhook: `src/server/github.ts`
`POST /api/github/:workspace`, public (registered in `index.ts` with `http()` like `authRoutes`, not `guard`): Host check (export `hostAllowed`), `Content-Type: application/json` else 415 ("set Content type to application/json in GitHub"), 1 MB cap. Unknown workspace, not connected, or a missing/wrong `X-Hub-Signature-256` (`sha256=` + hex HMAC of the raw body, compared with `timingSafeEqual`) all answer the same 401 `Invalid signature`. `X-GitHub-Event`:
- `ping` → 200 `{ ok: true }`.
- `pull_request` (`opened`, `reopened`, `edited`, `ready_for_review`, `converted_to_draft`, `closed`, `synchronize`): **closing** refs = identifiers in `head.ref` (`(^|[/_-])([a-z]{2,5})-(\d+)(?=$|[/_-])`, case-insensitive), in `title`, and after a closing word in `body`; **contributing** refs = after a contributing word in title or body (a contributing word before an identifier wins over its closing mention). Magic-word statement: word, optional `:`, then identifiers separated by `,`, `and` or `&`. Only live issues of this workspace resolve (the integration's actor sees only it). Upsert `issue_links` (state `draft`/`open`/`merged`/`closed`, title, number).
- Automation on closing links only: draft → `backlog`/`todo` become `in_progress`; opened, reopened or ready (not draft) → `backlog`/`todo`/`in_progress` become `in_review`; closed with `merged: true` → anything but `done`/`canceled` becomes `done`, **unless** another closing PR link of that issue is still `open`/`draft`. Closed unmerged: state only. Never moves done/canceled issues.
- `push`: each commit whose message has a magic-word statement links as `commit` (url `commits[].url`, first line as title). If `ref` is `refs/heads/<repository.default_branch>`, closing commits move their issues to `done` (same guard).
- Other events → 200 `{ ignored: "<event>" }`. Handled events answer 200 `{ linked: ["DKT-12"], moved: { "DKT-12": "in_review" } }` so GitHub's delivery log explains itself.

### Connect (admin, browser session)
| Method | Path | Returns |
|---|---|---|
| GET | /api/workspaces/:key/github | `GitHubConnection` |
| POST | /api/workspaces/:key/github | 201 `{ url, secret }`: connects (creating or reinstating the GitHub account) or issues a new secret |
| DELETE | /api/workspaces/:key/github | disconnects: secret NULL, the account suspended (history keeps "GitHub") |

`url` = request origin (`originOf`, `src/server/api.ts:64-68`) + `/api/github/<workspace>`. Writes publish `changed("member", key, <github username>)`.

### MCP
- get_issue: `branch <branchName>` in the meta line, and `## Links` (`PR #12 · open · Fix login · <url>`; `commit · Fix typo · <url>`). get_issue description adds "the git branch name to use, and linked pull requests".
- No tools to connect (credentials stay in the web app). list_members marks the account `integration`.

### UI
- Issue header: a "Copy git branch name" icon button next to Copy ID; `⌘/Ctrl+Shift+.` on the issue page (match `e.code === "Period"`), toast "Copied youssef/dkt-12-fix-login".
- Issue page: a **Pull requests** section after Docs when `links` exist: PR icon, title (`dir="auto"`), `#12`, state chip (Draft, Open, Merged, Closed), opens GitHub in a new tab (`rel="noopener noreferrer"`); commits listed below in muted text.
- Workspace settings (admins): a **GitHub** section: Connect → shows the payload URL and secret once, with steps ("GitHub repo or org → Settings → Webhooks → Add webhook: Payload URL, Content type application/json, Secret, events Pull requests and Pushes"); when connected: New secret, Disconnect (confirm).
- README "Going further": a short "Connect GitHub" (the host must be reachable by GitHub and listed in `DOCKET_HOSTS`).

### Interaction with DKT-3 and DKT-18
The payload URL is under `/api/github/<workspace>`, independent of app URLs. Per-workspace usernames let every workspace's account be plain `github`. Identifiers resolve only in the connected workspace, which stays correct when team keys become per-workspace. If DKT-18 has landed, express the automation by category: draft moves `triage`/`backlog`/`unstarted` issues to the team's first `started` status; opened/ready moves them (and `started` ones) to `in_review` only if the team has that key; merge moves to the team's first `completed` status; `completed`/`canceled` issues never move.

## Acceptance criteria

- [ ] An admin connects GitHub from settings and gets a payload URL and a secret once; members and API keys get 403.
- [ ] A signed PR whose branch is `ana/dkt-12-x` links DKT-12 and moves it to in_review; merging moves it to done as "GitHub"; an unsigned or wrongly signed delivery changes nothing (401).
- [ ] `Fixes DKT-1, DKT-2 and DKT-3` links all three; `Part of DKT-4` links without moving it; a second open PR keeps its issue from closing when the first merges.
- [ ] Pushing a closing commit to the default branch closes the issue; to another branch it only links.
- [ ] The issue page and get_issue show the branch name and links; the GitHub account never appears in pickers and can't be delegated to.

## Tests

`test/github.test.ts` (new). Sign bodies in the test with `createHmac("sha256", secret)` over the exact bytes sent; send with plain `fetch` (no credentials, `X-GitHub-Event`, `X-Hub-Signature-256`, JSON):
- connect as `s.as("admin", "cookie")` → 201 `{ url, secret }`; bearer → 403; member → 403.
- `ping` → 200; bad signature, no signature, unknown workspace, disconnected → 401; `application/x-www-form-urlencoded` → 415.
- `pull_request opened` with `head.ref: "ana/gh-1-login"` → GH-1 `in_review`, `links[0]` state open; activity (if DKT-9 is in) actor `github`.
- draft PR on a todo issue → in_progress; an in_review issue isn't moved back by a draft.
- body `Fixes GH-2, GH-3 and GH-4` → three links; `Part of GH-5` → link, status unchanged.
- two PRs closing GH-6: merge one → still open state; merge the other → done. Closed unmerged → status unchanged. done/canceled issues never move.
- `push` to `main` (default branch) with "fix GH-7" → done; to `feature` → link only.
- an identifier from another workspace's team → ignored (`linked` excludes it).
- `GET /api/issues/GH-1` as ana → `branchName: "ana/gh-1-<slug>"`; Arabic title → `ana/gh-8`; MCP get_issue shows `branch`.
- delegating to `github` → 400; `/api/workspaces/acme/members` shows `integration: true`.

`test/migrations.test.ts`: frozen pre-migration fixture survives; issues come back with `links: []`.

## SPEC.md

- New **GitHub** section: connecting, the account, the payload URL and signature check, linking rules and magic words, the fixed automation, branch names.
- **Data**: `github_integrations`, `issue_links`; `Issue.branchName`, `Issue.links`; `WorkspaceMember.integration`.
- **MCP**: get_issue shows branch and links. **UI**: branch-name button and shortcut, Pull requests section, GitHub settings.

## Out of scope

- A GitHub App, API calls to GitHub, linkback comments, PR reviews/checks, GitLab, per-team automation settings, branch-format settings, outbound webhooks (DKT-12).