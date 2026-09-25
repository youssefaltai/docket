// Signed-out screens: first-run setup, and signing in with a one-time code (a sign-in link or an invite).
import { useEffect, useState } from "react";
import type { CodeInfo } from "../shared/types";
import { HttpError } from "./api";
import { auth } from "./auth";
import { Logo } from "./ui";

/** A full reload into the app, so it boots with the new session. */
const enter = () => location.replace("/");

/** "Ana María" or "ana.maria@x.io" → "ana-maria": a starting point the user can edit. */
const suggestUsername = (from: string) =>
  from
    .split("@")[0]!
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 32);

const message = (err: unknown) =>
  err instanceof HttpError && err.status === 401 ? "This code is invalid or has expired." : String((err as Error).message);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field auth-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** Profile fields for a new account; the username follows the name until edited. */
function useProfile(initial: string) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState(() => suggestUsername(initial));
  const [edited, setEdited] = useState(false);
  const fields = (
    <>
      <Field label="Your name">
        <input
          className="input"
          dir="auto"
          autoFocus
          autoComplete="name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!edited) setUsername(suggestUsername(e.target.value) || suggestUsername(initial));
          }}
        />
      </Field>
      <Field label="Username">
        <input
          className="input mono"
          autoComplete="username"
          value={username}
          onChange={(e) => {
            setEdited(true);
            setUsername(e.target.value.toLowerCase());
          }}
        />
      </Field>
    </>
  );
  return { name: name.trim(), username: username.trim(), fields };
}

export function Setup() {
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [workspace, setWorkspace] = useState("");
  const profile = useProfile(email);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = !!(code.trim() && email.trim() && profile.name && profile.username && workspace.trim()) && !busy;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    auth
      .setup({ code, email, name: profile.name, username: profile.username, workspace: { name: workspace.trim() } })
      .then(enter, (err) => {
        setError(err instanceof HttpError && err.status === 409 ? "Docket is already set up. Sign in instead." : message(err));
        setBusy(false);
      });
  };

  return (
    <form className="empty login auth" onSubmit={submit}>
      <Logo />
      <h2>Set up Docket</h2>
      <p>Enter the setup code from the server's log, then create your account. You'll be the admin of your first workspace.</p>
      <Field label="Setup code">
        <input className="input mono" autoFocus autoComplete="off" placeholder="XXXXX-XXXXX" value={code} onChange={(e) => setCode(e.target.value)} />
      </Field>
      <Field label="Email">
        <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      {profile.fields}
      <Field label="Workspace name">
        <input className="input" dir="auto" placeholder="Acme" value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
      </Field>
      {error && <small className="login-error">{error}</small>}
      <button className="btn btn-primary" disabled={!ready}>
        Create account
      </button>
    </form>
  );
}

/** The code in `#XXXXX-XXXXX` (a pasted link), taken out of the address bar right away. */
function takeCode(): string {
  const code = decodeURIComponent(location.hash.slice(1)).trim();
  if (code) history.replaceState(null, "", location.pathname + location.search);
  return code;
}

/** Accepts a whole link or just its code. */
const codeFrom = (input: string) => input.trim().split("#").pop()!.trim();

export function Login() {
  const [code, setCode] = useState(takeCode);
  const [input, setInput] = useState("");
  const [info, setInfo] = useState<CodeInfo | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // A code needs no more input unless it's an invite for someone without an account yet.
  const use = (value: string) => {
    setBusy(true);
    setError("");
    auth.peek(value).then(
      (found) => {
        if (found.needsProfile) {
          setCode(value);
          setInfo(found);
          setBusy(false);
        } else auth.redeem(value).then(enter, fail);
      },
      fail,
    );
  };
  const fail = (err: unknown) => {
    setError(message(err));
    setCode("");
    setInfo(null);
    setBusy(false);
  };

  useEffect(() => {
    if (code) use(code);
    else auth.needsSetup().then((needed) => needed && location.replace("/setup"), () => {});
  }, []);

  if (info) return <Join code={code} info={info} onError={fail} />;
  return (
    <form
      className="empty login auth"
      onSubmit={(e) => {
        e.preventDefault();
        if (input.trim() && !busy) use(codeFrom(input));
      }}
    >
      <Logo />
      <h2>Sign in to Docket</h2>
      <p>Paste your sign-in link or code. Ask a workspace admin for one, or make one in Settings on a device where you're signed in.</p>
      <input
        className="input mono"
        autoFocus
        autoComplete="one-time-code"
        placeholder="Link or XXXXX-XXXXX"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        disabled={busy}
      />
      {error && <small className="login-error">{error}</small>}
      <button className="btn btn-primary" disabled={!input.trim() || busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

/** Accepting an invite as someone new: pick a name and username, then you're in. */
function Join({ code, info, onError }: { code: string; info: CodeInfo; onError: (err: unknown) => void }) {
  const profile = useProfile(info.email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = !!(profile.name && profile.username) && !busy;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    auth.redeem(code, { name: profile.name, username: profile.username }).then(enter, (err) => {
      // A taken or invalid username keeps the form; anything else (expired, used) starts over.
      if (err instanceof HttpError && (err.status === 400 || err.status === 409)) {
        setError(err.message);
        setBusy(false);
      } else onError(err);
    });
  };
  return (
    <form className="empty login auth" onSubmit={submit}>
      <Logo />
      <h2 dir="auto">Join {info.workspace ?? "Docket"}</h2>
      <p>
        You're invited as <strong>{info.email}</strong>. Choose how you appear to others.
      </p>
      {profile.fields}
      {error && <small className="login-error">{error}</small>}
      <button className="btn btn-primary" disabled={!ready}>
        Join
      </button>
    </form>
  );
}
