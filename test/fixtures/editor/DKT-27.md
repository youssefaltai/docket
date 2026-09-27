Blocked by DKT-3: this builds on teams having an internal id (DKT-6), requests acting in one workspace (DKT-4), and the `guest` role that DKT-5's migration already allows.

## Why

Every workspace member sees every team. There's no way to keep a team's issues to the people working on it (HR, security, a client project), or to bring an outside contractor into one team without showing them the whole workspace. Linear covers both with team membership, private teams and the Guest role.

## Linear's behaviour

- **Public teams.** "All members of a workspace can view and join teams as long as the team is not private". Members join and leave on their own ([teams](https://linear.app/docs/teams)).
- **Private teams** ([private teams](https://linear.app/docs/private-teams)):
  - non-members "will not be able to see issues associated with the team";
  - "Anyone in the workspace can create a new private team. Only workspace owners, admins, and team owners can change visibility of an existing team";
  - admins see private teams in settings and get a warning before joining one;
  - you can't @mention a non-member in a private team's issue.
- **Guests** ([members and roles](https://linear.app/docs/members-roles)):
  - they "access issues, projects, and documents for the teams they are explicitly added to" and "take the same actions as Members within those teams";
  - they can't "view workspace-wide features" or "access settings beyond their own Account tab", and can't be team owners.
- Agents: "team access available to your app can be changed or revoked at any time by workspace admins" ([agents](https://linear.app/developers/agents)).

**Deliberate differences:**
- No team-owner role (a Linear Business feature).
- No private-issue sharing (Enterprise).
- Admins join a private team through its members dialog, with the same warning, rather than a separate settings page.

## Where things are today

After DKT-3:

- `teams` has `id, workspace, key, …` and no membership or visibility.
- `workspace_members.role` allows `guest` but nothing uses it.
- `src/server/tracker.ts`: every lookup and list scopes by workspace only. In today's code these are `teamRow` 173-178, `listScope` 364-383, `issueRef` 284-296, `documentRow` 783-792, `listLabels` 739-748, `listTrash` 669-681 and `getIssue` 476-502; the line numbers move with DKT-6.
- `src/server/access.ts:134`: `PERSON_ROLES = ["admin", "member"]`.
- `src/server/access.ts:594-598`: `invite` takes a role only.
- `src/server/index.ts:20`: a socket subscribes per workspace (`topic`).
- `src/server/index.ts:77`: events publish per workspace.
- `src/web/main.tsx:318`: the sidebar lists every team.
- `src/web/modals.tsx`: the new-team modal.
- `src/web/settings.tsx:405-465`: members and invites.

## Design

**Migration.** Append the next one, additive:

```sql
CREATE TABLE team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members(user_id);
ALTER TABLE teams ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
-- Everyone is in every team today, so nothing changes for anyone.
INSERT INTO team_members (team_id, user_id, created_at)
  SELECT t.id, m.user_id, m.created_at FROM teams t JOIN workspace_members m ON m.workspace = t.workspace;
```

**One visibility rule** (`tracker.ts`). `visibleTeamIds(a)` is the set of teams in the request's workspace where you're in `team_members`, plus every public team unless your role is `guest`. Everything team-scoped filters through it, and anything outside it is 404, like another workspace:

- team lists and counts;
- issue and doc lists, search and labels;
- lookups by identifier or slug;
- trash;
- `Issue.docs` and `Document.issues`;
- `GET /api/locate`;
- MCP.

Where an issue relates to one you can't see:
- `blockedBy`, `blocks` and `children` leave it out;
- `parent` shows as `null`;
- identifier chips for it render as plain text.
New relations to an invisible issue are 404.

Assignee and delegate (`activeMemberId`) must see the issue's team: 400 `@x isn't in team BRD`.

**Who can do what**

| Action | Who |
|---|---|
| See a public team | members, admins, agents (not guests) |
| See a private team | its team members only; admins too once they join |
| Create a team, public or private | members and admins; the creator becomes a team member; guests and agents can't |
| Join a public team, or leave any team | yourself (guests can't self-join); the last member of a private team can't leave (409 `Add someone else first`) |
| Add or remove team members | anyone in the team, and admins |
| Make a team private or public | admins |
| Invite a guest | admins, choosing at least one team |

New workspace members join every public team automatically (people through invites, agents when created), so the sidebar keeps working as today. Guests join only the teams on their invite.

**Contract (`types.ts`)**
- `Role` adds `"guest"`.
- `Team` gains `private: boolean` and `member: boolean` (you're in it).
- `TeamInput.private?`.
- `TeamPatch.private?` (admins).
- Invite body: `{ role?, teams? }`.

**REST**
- `GET /api/teams/:key/members` → `UserRef[]`.
- `POST /api/teams/:key/members { username }` (`"me"` to join) → `Team`.
- `DELETE /api/teams/:key/members/:username` → `Team`.
- `PATCH /api/teams/:key { private }`.
- `POST /api/workspaces/:key/invites { role: "guest", teams: ["BRD"] }`: redeeming adds those team memberships.
- `PATCH …/members/:username { role: "guest" }`.

All of these need a session (they manage access) and publish `changed("team", …)` or `changed("member", …)`.

**Realtime.** A private team's events publish to `team:<id>` instead of `workspace:<ws>`. A socket subscribes to its workspaces plus the private teams it can see. Any change to team membership or visibility calls `revoked({ userId })` for the people affected, so their sockets reconnect with what's current (`index.ts:81-86`).

**MCP**
- `list_teams` shows visible teams with `private` and `member` markers.
- No membership tools: agents never mint access.
- An agent sees what its membership allows, like anyone else.

**UI**
- The sidebar lists the teams you're in, with a lock icon on private ones, plus a "Browse teams" link to `/<ws>/teams` (all visible teams, with Join and Leave).
- Team header menu: Members (a dialog: list, add by picker, remove), Join or Leave, and Make private or Make public (admins; the confirmation says who loses access).
- An admin opening a private team's members dialog without being a member gets Linear's warning: "Join <team>? You'll see its issues."
- New team modal: a "Private" switch.
- Workspace settings:
  - the role menu includes Guest;
  - the Guest invite needs a team picker;
  - guest rows show their teams.
- Guests see only Settings → Account, and no "All issues" or "All docs" beyond their teams.

**SPEC.** A new "Teams and guests" subsection under Access.

### Open question

1. **What a guest sees in the member list.** Recommended: only people who share a team with them (and pickers only ever offer people who see the team). Linear doesn't document it; "limited access" argues for less.
2. **Private-team issues that already have relations to public ones.** Recommended: keep them, hidden per viewer as above, rather than refuse making a team private. Making a team private is rare and reversible.

## Acceptance criteria

- [ ] Existing workspaces see no change after the migration: everyone is in every team, and all teams are public.
- [ ] A private team's issues, docs, labels, counts, events and identifiers are invisible (404) to non-members, over REST, MCP and `/ws`, including admins who haven't joined.
- [ ] A guest invited to `BRD` sees only `BRD`, can do everything a member can there, can't create teams or self-join, and gets 404 for other teams.
- [ ] Relations and doc refs to invisible issues are hidden per viewer. New ones are 404.
- [ ] Assigning or delegating to someone who can't see the team is 400.
- [ ] Only admins toggle `private`. The last member can't leave a private team.

## Tests

**New `test/teams-access.test.ts`:**
- a public team seen by all;
- a private team seen only by its members;
- an admin not a member → 404;
- a guest with and without the team;
- join and leave rules;
- `/ws` events for a private team reach members only;
- MCP `list_teams` and `get_issue` per caller;
- an assignee who can't see the team → 400;
- hidden relations and doc refs.

**`test/migrations.test.ts`:** freeze the previous schema, migrate, and assert every member is in every team and all teams are public.

## SPEC.md

- **Access**: the new "Teams and guests" subsection (the rules table above).
- **Data**: `team_members`, `teams.private`.
- **REST**: team members routes, invite `teams`.
- **Realtime**: per-team topics for private teams.
- **MCP**: `list_teams` markers.
- **UI**: sidebar, Browse teams, team menu, private switch, guest invite.
- **`types.ts`**: `Role`, `Team`, `TeamInput`, `TeamPatch`.

## Out of scope

- Team owners.
- An admin-only team-creation setting (see DKT-7).
- Sharing single private issues.
- Guests on workspace-wide views (Docket has none yet).
- Sub-teams.
- Per-team notification settings.

**Project rules:**
- Linear's features, nano implementation; no new dependencies.
- Append the next migration with a frozen-fixture test.
- SPEC.md and `types.ts` change in the same branch.
- REST, MCP and UI stay in parity. Every mutation publishes `changed`. Outside what you can see is 404.
- UI: light, Linear-like; works at phone width.
- Branch `feature/private-teams-guests`. `bun test` and `bun run typecheck` pass. Merge and delete the branch.
- Deploy after `./backup.sh` with the rehearsal routine.