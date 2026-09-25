// Members: people and agents with their own token, managed by admins (see SPEC "Members").
import { useState } from "react";
import type { Member, MemberKind, MemberRole, MemberToken } from "../shared/types";
import { api } from "./api";
import { ModalHead } from "./modals";
import { Picker } from "./pickers";
import { Avatar, CopyIcon, Modal, MoreIcon, PlusIcon, cls, errorToast, toast, useFetch } from "./ui";

type View = { kind: "list" } | { kind: "add" } | { kind: "token"; issued: MemberToken; fresh: boolean };

export function MembersModal({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<View>({ kind: "list" });
  const members = useFetch(() => api.members(), []);
  const issued = (fresh: boolean) => (issued: MemberToken) => {
    members.reload();
    setView({ kind: "token", issued, fresh });
  };
  const list = () => setView({ kind: "list" });
  return (
    <Modal label="Members" className="modal-sm" onClose={onClose}>
      <ModalHead onClose={onClose}>
        <span className="modal-title">{view.kind === "add" ? "Add member" : "Members"}</span>
      </ModalHead>
      {view.kind === "list" && (
        <MemberList members={members.data} onChange={members.reload} onToken={issued(false)} onAdd={() => setView({ kind: "add" })} />
      )}
      {view.kind === "add" && <AddMember onCancel={list} onCreated={issued(true)} />}
      {view.kind === "token" && <IssuedToken {...view} onDone={list} />}
    </Modal>
  );
}

function MemberList({
  members,
  onChange,
  onToken,
  onAdd,
}: {
  members: Member[] | null;
  onChange: () => void;
  onToken: (t: MemberToken) => void;
  onAdd: () => void;
}) {
  const run = (m: Member, action: string) => {
    if (action === "role") {
      api.updateMember(m.name, m.role === "admin" ? "member" : "admin").then(onChange, errorToast);
    } else if (action === "token") {
      if (m.revokedAt || confirm(`Issue a new token for ${m.name}? Their current one stops working.`)) {
        api.rotateToken(m.name).then(onToken, errorToast);
      }
    } else if (action === "revoke") {
      if (confirm(`Revoke ${m.name}’s token? They’re signed out everywhere. Their name stays reserved.`)) {
        api.revokeMember(m.name).then(onChange, errorToast);
      }
    }
  };
  const actions = (m: Member) =>
    m.revokedAt
      ? [{ value: "token", label: "Reinstate with a new token" }]
      : [
          { value: "role", label: m.role === "admin" ? "Make member" : "Make admin" },
          { value: "token", label: "New token" },
          { value: "revoke", label: "Revoke" },
        ];
  return (
    <>
      <div className="members">
        {members?.length === 0 && (
          <p className="members-empty">
            Give a person or an agent their own token, and everything they write carries their name. Until then, everyone
            shares the access token and types a name.
          </p>
        )}
        {members?.map((m) => (
          <div key={m.name} className={cls("member", m.revokedAt && "revoked")}>
            <Avatar name={m.name} />
            <span className="member-name" dir="auto">
              {m.name}
            </span>
            <span className="member-meta">
              {[m.kind === "agent" && "Agent", m.role === "admin" && "Admin", m.revokedAt && "Revoked"].filter(Boolean).join(" · ")}
            </span>
            <Picker label={`Manage ${m.name}`} options={actions(m)} selected={[]} onPick={(a) => run(m, a)} className="icon-btn sm" align="end">
              <MoreIcon />
            </Picker>
          </div>
        ))}
      </div>
      <div className="modal-foot">
        <span className="grow" />
        <button className="btn btn-primary" onClick={onAdd}>
          <PlusIcon />
          Add member
        </button>
      </div>
    </>
  );
}

function AddMember({ onCancel, onCreated }: { onCancel: () => void; onCreated: (t: MemberToken) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<MemberKind>("human");
  const [role, setRole] = useState<MemberRole>("member");
  const [busy, setBusy] = useState(false);
  const ready = !!name.trim() && !busy;
  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    setBusy(true);
    api.createMember({ name: name.trim(), kind, role }).then(onCreated, (err) => {
      errorToast(err);
      setBusy(false);
    });
  };
  const choice = <T extends string>(value: T, current: T, set: (v: T) => void, label: string) => (
    <button type="button" className={cls("tab", value === current && "on")} aria-pressed={value === current} onClick={() => set(value)}>
      {label}
    </button>
  );
  return (
    <>
      <form className="modal-form" onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input
            className="input"
            autoFocus
            dir="auto"
            placeholder={kind === "agent" ? "claude-frontend" : "Ana"}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <small>Shown on everything they write, and used to assign issues to them.</small>
        </label>
        <div className="field">
          <span>Kind</span>
          <div className="tabs" role="group" aria-label="Kind">
            {choice<MemberKind>("human", kind, setKind, "Person")}
            {choice<MemberKind>("agent", kind, setKind, "Agent")}
          </div>
        </div>
        <div className="field">
          <span>Role</span>
          <div className="tabs" role="group" aria-label="Role">
            {choice<MemberRole>("member", role, setRole, "Member")}
            {choice<MemberRole>("admin", role, setRole, "Admin")}
          </div>
          <small>Admins can add and revoke members.</small>
        </div>
        <button type="submit" hidden />
      </form>
      <div className="modal-foot">
        <span className="grow" />
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!ready} onClick={() => submit()}>
          Add member
        </button>
      </div>
    </>
  );
}

/** The one time a token is shown, with what to paste where. */
function IssuedToken({ issued: { member, token }, fresh, onDone }: { issued: MemberToken; fresh: boolean; onDone: () => void }) {
  const origin = location.origin;
  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(() => toast(`${what} copied`), errorToast);
  const agent = member.kind === "agent";
  const command = `claude mcp add --transport http --scope user docket ${origin}/mcp --header "Authorization: Bearer ${token}"`;
  return (
    <>
      <div className="modal-form">
        <p className="token-lead">
          {fresh ? "Added" : "New token for"} <strong dir="auto">{member.name}</strong>.{" "}
          {agent ? "Connect the agent with this command." : "Send them this link to sign in."} It’s shown only once.
        </p>
        <div className="token-box mono">{agent ? command : `${origin}/#login=${token}`}</div>
        <div className="token-actions">
          {agent ? (
            <button className="btn" onClick={() => copy(command, "Command")}>
              <CopyIcon />
              Copy command
            </button>
          ) : (
            <button className="btn" onClick={() => copy(`${origin}/#login=${token}`, "Link")}>
              <CopyIcon />
              Copy login link
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => copy(token, "Token")}>
            Copy token only
          </button>
        </div>
      </div>
      <div className="modal-foot">
        <span className="grow" />
        <button className="btn btn-primary" onClick={onDone}>
          Done
        </button>
      </div>
    </>
  );
}
