import { useEffect, useRef, useState } from "react";
import type { ProviderId } from "../src/shared/domain";
import type { HostMessage } from "../src/shared/messages";
import type { State } from "./state";
import { post, vscode } from "./bridge";
import { resetLabel, tightestWindow } from "../src/verification/claims";
import { droppedFiles, isFileDrop } from "./drop";
const commands = ["/summary", "/compare", "/context", "/usage", "/new"];
export function Composer({
  state,
  panel,
}: {
  state: State;
  panel: (name?: "settings" | "usage") => void;
}) {
  const saved = vscode.getState();
  const [draft, setDraft] = useState(saved?.draft ?? "");
  const [provider, setProvider] = useState<ProviderId>(
    saved?.provider ?? "codex",
  );
  const [models, setModels] = useState<Partial<Record<ProviderId, string>>>(
    saved?.models ?? {},
  );
  const [efforts, setEfforts] = useState<Partial<Record<ProviderId, string>>>(
    saved?.efforts ?? {},
  );
  const [compare, setCompare] = useState(false);
  const [dropError, setDropError] = useState<string>();
  const [attaching, setAttaching] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState(false);
  const [contextMenu, setContextMenu] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const pendingId = useRef<string | undefined>(undefined);
  const other: ProviderId = provider === "codex" ? "claude" : "codex";
  const status = state.providers.find((item) => item.id === provider);
  const otherStatus = state.providers.find((item) => item.id === other);
  const modelFor = (id: ProviderId) => {
    const list = state.providers.find((item) => item.id === id)?.models ?? [];
    return list.some((model) => model.id === models[id])
      ? models[id]!
      : (list[0]?.id ?? "");
  };
  const model = modelFor(provider);
  const selected = status?.models.find((item) => item.id === model);
  const effortsFor = (id: ProviderId) =>
    state.providers
      .find((item) => item.id === id)
      ?.models.find((item) => item.id === modelFor(id))?.efforts ?? [];
  // A level chosen for one model is meaningless on another, so only send one the
  // currently selected model actually offers.
  const effortFor = (id: ProviderId) => {
    const chosen = efforts[id];
    return chosen && effortsFor(id).some((option) => option.id === chosen)
      ? chosen
      : undefined;
  };
  useEffect(() => {
    const listener = (event: MessageEvent<HostMessage>) => {
      if (event.data.type === "attachments" || event.data.type === "error")
        setAttaching(false);
      if (event.data.type === "composer") {
        if (event.data.provider) setProvider(event.data.provider);
        if (event.data.compare !== undefined) setCompare(event.data.compare);
        input.current?.focus();
      }
      if (
        event.data.type === "message" &&
        event.data.message.id === pendingId.current
      ) {
        setDraft("");
        pendingId.current = undefined;
        setPending(false);
      }
      if (
        event.data.type === "error" ||
        (event.data.type === "busy" && !event.data.busy)
      ) {
        pendingId.current = undefined;
        setPending(false);
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);
  useEffect(() => {
    vscode.setState({ draft, provider, models, efforts });
  }, [draft, provider, models, efforts]);
  useEffect(() => {
    const textarea = input.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
    }
  }, [draft]);
  const send = () => {
    if (attaching) return;
    if (state.busy || pending || !draft.trim()) return;
    if (commands.includes(draft.trim())) {
      switch (draft.trim()) {
        case "/summary":
          if (model) post({ type: "summary", provider, model });
          break;
        case "/compare":
          setCompare(true);
          break;
        case "/context":
          setContextMenu(true);
          break;
        case "/usage":
          panel("usage");
          break;
        case "/new":
          post({ type: "new" });
          break;
      }
      setDraft("");
      return;
    }
    if (!model || status?.state !== "connected") {
      panel("settings");
      return;
    }
    const requestId = crypto.randomUUID();
    pendingId.current = requestId;
    setPending(true);
    panel(undefined);
    post({
      type: "send",
      requestId,
      text: draft,
      provider,
      model,
      compare,
      ...(effortFor(provider) ? { effort: effortFor(provider) } : {}),
      ...(compare
        ? {
            otherModel: modelFor(other) || "default",
            ...(effortFor(other) ? { otherEffort: effortFor(other) } : {}),
          }
        : {}),
    });
  };
  // A spent limit is the reason the next send will fail, so surface it in the composer
  // rather than leaving it in a panel the user has no reason to open.
  const tightest = tightestWindow(status?.usage?.quota);
  const spent = tightest?.state === "exhausted" ? tightest : undefined;
  const suggestions =
    draft.startsWith("/") && !draft.includes(" ")
      ? commands.filter((command) => command.startsWith(draft))
      : [];
  return (
    <footer
      className={`composer${dragging ? " dragging" : ""}`}
      onDragOver={(event) => {
        if (!isFileDrop(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect =
          state.busy || attaching ? "none" : "copy";
        setDragging(!state.busy && !attaching);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={(event) => {
        if (!isFileDrop(event.dataTransfer)) return;
        event.preventDefault();
        setDragging(false);
        if (state.busy || attaching) {
          setDropError(
            "Wait for the current operation to finish before attaching files.",
          );
          return;
        }
        setDropError(undefined);
        setAttaching(true);
        void droppedFiles(event.dataTransfer)
          .then((message) => post(message))
          .catch((error) => {
            setAttaching(false);
            setDropError(
              error instanceof Error
                ? error.message
                : "Could not attach dropped files.",
            );
          });
      }}
    >
      {dragging && (
        <div className="drop-hint">
          Drop files to attach to your next message
        </div>
      )}
      {attaching && <div role="status">Attaching files…</div>}
      {dropError && (
        <div role="alert" className="error">
          {dropError}
        </div>
      )}
      <div className="attachments">
        {state.chat?.attachments.map((item) => (
          <details className="attachment" key={item.id}>
            <summary>
              {item.kind === "capsule" ? "Capsule · " : ""}
              {item.name}
            </summary>
            <div className="attachment-body">
              <pre>{item.content}</pre>
              <div className="row">
                {item.sourceId && (
                  <button
                    disabled={state.busy}
                    onClick={() => post({ type: "open", id: item.sourceId! })}
                  >
                    Open source chat
                  </button>
                )}
                <button
                  disabled={state.busy}
                  onClick={() =>
                    post({ type: "removeAttachment", id: item.id })
                  }
                >
                  Remove
                </button>
              </div>
            </div>
          </details>
        ))}
      </div>
      {suggestions.length > 0 && (
        <div className="slash-commands" aria-label="Slash command suggestions">
          {suggestions.map((command) => (
            <button
              key={command}
              onClick={() => {
                setDraft(command);
                input.current?.focus();
              }}
            >
              {command}
            </button>
          ))}
        </div>
      )}
      <label className="sr-only" htmlFor="prompt">
        Message Crossbar
      </label>
      <textarea
        id="prompt"
        ref={input}
        value={draft}
        rows={3}
        maxLength={100_000}
        placeholder="Ask about your code…"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          // An IME uses Enter to accept a candidate, so never send mid-composition.
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            send();
          }
          if (event.key === "Escape") {
            if (state.busy) post({ type: "stop" });
            setContextMenu(false);
          }
        }}
        aria-describedby="composer-hint"
      />
      <div className="composer-tools">
        <button
          disabled={state.busy}
          aria-expanded={contextMenu}
          onClick={() => setContextMenu(!contextMenu)}
        >
          + Context
        </button>
        <button
          disabled={state.busy}
          aria-pressed={compare}
          onClick={() => setCompare(!compare)}
        >
          Compare{compare ? " ✓" : ""}
        </button>
        <span className="spacer" />
        {state.busy ? (
          <button className="primary" onClick={() => post({ type: "stop" })}>
            Stop
          </button>
        ) : (
          <button
            className="primary"
            disabled={pending || attaching || !draft.trim()}
            onClick={send}
          >
            Send
          </button>
        )}
      </div>
      {contextMenu && (
        <div className="context-menu">
          {(
            [
              ["current", "Current file"],
              ["selection", "Selection"],
              ["file", "Choose files"],
              ["diff", "Git diff"],
              ["problems", "Problems"],
              ["editors", "Open editors"],
            ] as const
          ).map(([kind, label]) => (
            <button
              key={kind}
              disabled={state.busy}
              onClick={() => {
                post({ type: "attach", kind });
                setContextMenu(false);
                input.current?.focus();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="selectors">
        <label>
          <span className="sr-only">Provider</span>
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value as ProviderId)}
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
        </label>
        <label className="model-select">
          <span className="sr-only">Model</span>
          <select
            value={model}
            onChange={(event) =>
              setModels({ ...models, [provider]: event.target.value })
            }
          >
            {status?.models.length ? (
              status.models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))
            ) : (
              <option value="">Connect to select model</option>
            )}
          </select>
        </label>
        {!!effortsFor(provider).length && (
          <label className="effort-select">
            <span className="sr-only">Reasoning effort</span>
            <select
              value={efforts[provider] ?? ""}
              onChange={(event) =>
                setEfforts({ ...efforts, [provider]: event.target.value })
              }
            >
              <option value="">Effort: default</option>
              {effortsFor(provider).map((option) => (
                <option
                  key={option.id}
                  value={option.id}
                  title={option.description}
                >
                  Effort: {option.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {selected?.description && (
        <p className="model-description">{selected.description}</p>
      )}
      {compare && (
        <div className="compare-options">
          <p>Sends to both providers and uses both quotas.</p>
          <label>
            Compare with {other}
            <select
              aria-label="Comparison model"
              value={modelFor(other)}
              onChange={(event) =>
                setModels({ ...models, [other]: event.target.value })
              }
            >
              {otherStatus?.models.length ? (
                otherStatus.models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))
              ) : (
                <option value="">Not connected</option>
              )}
            </select>
          </label>
          {!!effortsFor(other).length && (
            <label>
              Effort
              <select
                aria-label="Comparison reasoning effort"
                value={efforts[other] ?? ""}
                onChange={(event) =>
                  setEfforts({ ...efforts, [other]: event.target.value })
                }
              >
                <option value="">Model default</option>
                {effortsFor(other).map((option) => (
                  <option
                    key={option.id}
                    value={option.id}
                    title={option.description}
                  >
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      <div className="composer-hint" id="composer-hint">
        <span>Enter to send · Shift + Enter for a new line</span>
        {spent ? (
          <button className="quiet quota-spent" onClick={() => panel("usage")}>
            {provider === "codex" ? "Codex" : "Claude"} limit reached ·{" "}
            {resetLabel(spent.resetsAt).replace("Resets ", "resets ")}
          </button>
        ) : (
          <button className="quiet" onClick={() => panel("settings")}>
            {status?.state === "connected" ? "Connected" : "Connect provider"}
          </button>
        )}
      </div>
    </footer>
  );
}
