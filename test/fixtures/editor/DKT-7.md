## Why

SPEC.md says agents "work in teams but manage nothing" (`SPEC.md:35`, `src/shared/types.ts:44`). But the code only checks membership. An agent's token can create teams (`POST /api/teams`, MCP `create_team`) and rename them (`PATCH /api/teams/:key`, `update_team`). Team keys are permanent and prefix every identifier, so a stray agent-created team is litter that can't be undone. Code and SPEC disagree, and the MCP test (`test/mcp.test.ts:14`) exercises the undocumented behaviour.

## Linear's behaviour

- **Members.** Team creation is open to members by default. "Admins can restrict team creation to only admin users under Settings > Administration > Security" ([teams](https://linear.app/docs/teams)). The API models this as `teamCreationRole`, "the minimum role required to create teams" ([schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)).
- **Agents.** Agents are app users that "can be @mentioned, delegated issues through assignment, create and reply to comments, collaborate on projects and documents". They "are not able to also request `admin` scope", and "team access available to your app can be changed or revoked at any time by workspace admins" ([agents](https://linear.app/developers/agents)). Linear doesn't document agents creating teams.

**Decision.** Follow Linear's default for people: members and admins create teams and edit a team's name and description. Agents do neither; they work *in* teams that people set up. That is SPEC's rule, and it's consistent with Linear keeping workspace structure out of app users' hands.

**Deliberate difference:** no "only admins create teams" setting yet. That's Linear's opt-in restriction; add it only if asked.

## Where things are today

- `src/server/tracker.ts:188-206`: `createTeam` checks only `requireMember` (line 191).
- `src/server/tracker.ts:209-217`: `updateTeam` checks only `teamRow` (membership).
- `src/server/mcp.ts:227-243`: `create_team`, described as "…only create a team when asked to".
- `src/server/mcp.ts:245-260`: `update_team`.
- `src/server/access.ts:238-240`: `requirePerson`, the check `createWorkspace` uses. It isn't exported.
- `SPEC.md:35`: "agents work in teams but manage nothing".
- `SPEC.md:150-151`: the MCP rows for `create_team` and `update_team` don't mention it.
- `test/mcp.test.ts:14`: the agent `claude` creates team `MCP`.

## Design

**Server**
- Export `requirePerson` from `access.ts`. Give it a message parameter, defaulting to today's `"Only people can do that"`.
- `createTeam` and `updateTeam` call `requirePerson(a, "Agents can't create or change teams; ask a person")` first, so an agent gets 403 before any other check.
- This covers REST and MCP alike, since both go through `tracker`.
- No schema change.

**MCP descriptions**
- `create_team`: `"Create a team (people only). The key is 2–5 letters (uppercased), permanent, … Check list_teams first; only create a team when asked to."` Keep the rest of the current text, including "unique across all workspaces" until DKT-6 changes it.
- `update_team`: `"Update a team's name or description (people only); only the fields you pass change. …"`.
- Hiding both tools from agents is DKT-2's visibility map. If DKT-2 hasn't landed, the tools stay listed and fail with this 403.

**UI.** None; agents don't use the web app.

**Realtime.** Unchanged. A refused call publishes nothing.

## Acceptance criteria

- [ ] An agent token:
  - `POST /api/teams` → 403 `Agents can't create or change teams; ask a person`;
  - `PATCH /api/teams/:key` → 403;
  - MCP `create_team` and `update_team` → tool errors (403 text, or "not found" once DKT-2 hides them);
  - nothing is created or changed.
- [ ] A member (not admin) creates a team (201) and renames one (200). An admin still can.
- [ ] A read key is still refused writes with its existing 403.
- [ ] SPEC.md states who can create and edit teams.

## Tests

**`test/mcp.test.ts`**
- Line 14: create team `MCP` with `s.api("POST", "/api/teams", { key: "MCP", workspace: s.workspace, name: "Agents" })` in `beforeAll`, instead of through `claude`.
- Add "agents can't create or change teams":
  - `claude.tool("create_team", { key: "BOT", name: "Bot" })` rejects;
  - `claude.api("POST", "/api/teams", { key: "BOT", workspace: s.workspace, name: "Bot" })` → 403;
  - `claude.api("PATCH", "/api/teams/MCP", { name: "x" })` → 403;
  - `GET /api/teams` has no `BOT` and `MCP` keeps its name.

**`test/users.test.ts`**, in "only admins manage the workspace" (35-46): add that ana (member) can `POST /api/teams` (201) and `PATCH` it (200), so members keep Linear's default.

## SPEC.md

- **Access → Workspaces** (line 35): after "agents work in teams but manage nothing", add "(no teams, members, invites or agents)". Add a sentence: "Any person in the workspace, member or admin, creates teams and edits a team's name and description, as in Linear by default; agents can't (403)."
- **MCP table** (150-151): `create_team` and `update_team` notes say "people only".
- **`types.ts:44`**: the `Role` comment becomes "Agents are members with role "agent": they work in teams but manage nothing (no teams, members or access)."

## Out of scope

- Hiding tools per caller (DKT-2).
- An admin-only team-creation setting (Linear's `teamCreationRole`).
- Team membership, private teams and guests (DKT-27).
- Per-workspace team keys (DKT-6).

**Project rules:**
- Linear's features, nano implementation.
- SPEC.md changes in the same branch.
- REST and MCP stay in parity.
- Branch `bugfix/agents-manage-no-teams`. `bun test` and `bun run typecheck` pass. Merge and delete the branch.