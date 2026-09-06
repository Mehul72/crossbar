import { useEffect, useState } from "react";
import type { State } from "./state";
import { post } from "./bridge";
import { resetLabel, usageLabel } from "../src/verification/claims";
export function Panels({
  panel,
  state,
  close,
}: {
  panel: string;
  state: State;
  close: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<string>();
  const [title, setTitle] = useState("");
  return (
    <section className="panel" aria-label={panel}>
      <header className="panel-heading">
        <h2>
          {panel === "settings"
            ? "Providers"
            : panel === "usage"
              ? "Usage & context"
              : "Conversations"}
        </h2>
        <button onClick={close} aria-label="Close panel">
          Close
        </button>
      </header>
      {panel === "history" ? (
        <>
          <label className="sr-only" htmlFor="history-search">
            Search chat titles
          </label>
          <input
            id="history-search"
            placeholder="Search conversations"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {state.history
            .filter((chat) =>
              chat.title.toLowerCase().includes(search.toLowerCase()),
            )
            .map((chat) => (
              <div className="history-row" key={chat.id}>
                {renaming === chat.id ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (title.trim())
                        post({ type: "rename", id: chat.id, title });
                      setRenaming(undefined);
                    }}
                  >
                    <input
                      aria-label="Conversation title"
                      value={title}
                      maxLength={120}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                    <button>Save</button>
                    <button
                      type="button"
                      onClick={() => setRenaming(undefined)}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <button
                      className="history-title quiet"
                      disabled={state.busy}
                      onClick={() => {
                        post({ type: "open", id: chat.id });
                        close();
                      }}
                    >
                      {chat.title}
                      <small>{new Date(chat.updatedAt).toLocaleString()}</small>
                    </button>
                    <div>
                      <button
                        disabled={state.busy}
                        onClick={() => {
                          setRenaming(chat.id);
                          setTitle(chat.title);
                        }}
                      >
                        Rename
                      </button>
                      <button
                        disabled={state.busy}
                        onClick={() => post({ type: "delete", id: chat.id })}
                      >
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          {state.history.length === 0 && (
            <p className="muted">Your conversations will appear here.</p>
          )}
        </>
      ) : (
        <>
          <button
            disabled={state.busy}
            onClick={() => post({ type: "refresh" })}
          >
            Refresh provider information
          </button>
          {state.providers.length === 0 && (
            <p className="muted">Checking local runtimes…</p>
          )}
          {state.providers.map((provider) => {
            const last = state.chat?.messages
              .filter(
                (message) => message.provider === provider.id && message.usage,
              )
              .at(-1);
            return (
              <div className="provider-card" key={provider.id}>
                <h3>{provider.id === "codex" ? "Codex" : "Claude"}</h3>
                {panel === "settings" ? (
                  <>
                    <p>
                      <span className={`status-dot ${provider.state}`} />
                      {provider.state}
                    </p>
                    <p className="muted">{provider.detail}</p>
                    <button
                      disabled={state.busy}
                      onClick={() =>
                        post({
                          type:
                            provider.state === "connected"
                              ? "disconnect"
                              : "connect",
                          provider: provider.id,
                        })
                      }
                    >
                      {provider.state === "connected"
                        ? "Disconnect"
                        : "Connect"}
                    </button>
                    {provider.state === "missing" && (
                      <p>
                        Install the official CLI, or set{" "}
                        <code>crossbar.{provider.id}Path</code> in VS Code
                        Settings.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <p>{usageLabel(provider.usage, now)}</p>
                    {provider.usage?.quota?.map((window) => (
                      <p key={window.name}>
                        {window.name}: {window.remaining.toFixed(0)}% remaining
                        <br />
                        <small>{resetLabel(window.resetsAt, now)}</small>
                      </p>
                    ))}
                    <p>
                      Context:{" "}
                      {last?.usage?.context
                        ? `${last.usage.context.used.toLocaleString()} / ${last.usage.context.limit.toLocaleString()} tokens`
                        : "Unavailable"}
                    </p>
                    <p>
                      Last response activity:{" "}
                      {last?.usage?.tokens
                        ? `${last.usage.tokens.input.toLocaleString()} input · ${last.usage.tokens.output.toLocaleString()} output tokens`
                        : "Unavailable"}
                    </p>
                    {last?.usage && (
                      <small>
                        Source: provider ·{" "}
                        {new Date(last.usage.observedAt).toLocaleTimeString()}
                        {now - last.usage.observedAt > 300_000
                          ? " · stale"
                          : ""}
                      </small>
                    )}
                  </>
                )}
              </div>
            );
          })}
          {panel === "settings" && (
            <p className="fine-print">
              Subscription authentication only. Crossbar does not fall back to
              API billing. Keep paid extra usage disabled in your provider
              accounts. Claude plan limits are shared with your other Claude
              sessions.
            </p>
          )}
        </>
      )}
    </section>
  );
}
