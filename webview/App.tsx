import { useEffect, useReducer, useRef, useState } from "react";
import type { HostMessage } from "../src/shared/messages";
import { reduce, initialState } from "./state";
import { post } from "./bridge";
import { ChatMessage } from "./Message";
import { Composer } from "./Composer";
import { Panels } from "./Panels";
export function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [panel, setPanel] = useState<"settings" | "usage" | "history">();
  // A disabled button alone reads as broken, so hold a label until the host is done.
  const [summarising, setSummarising] = useState(false);
  const [following, setFollowing] = useState(true);
  const scroll = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousChat = useRef<string | undefined>(undefined);
  useEffect(() => {
    const receive = (event: MessageEvent<HostMessage>) => {
      dispatch(event.data);
      if (event.data.type === "panel") setPanel(event.data.panel);
      // Watching busy alone would strand the label when two updates batch into no
      // net change, so end it on whatever the summary produces instead.
      if (
        (event.data.type === "busy" && !event.data.busy) ||
        event.data.type === "attachments" ||
        event.data.type === "error"
      )
        setSummarising(false);
    };
    window.addEventListener("message", receive);
    post({ type: "ready" });
    return () => window.removeEventListener("message", receive);
  }, []);
  useEffect(() => {
    if (scroll.current && following)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [state.chat?.messages, following]);
  useEffect(() => {
    if (state.chat?.id && previousChat.current !== state.chat.id) {
      heading.current?.focus();
      previousChat.current = state.chat.id;
    }
  }, [state.chat?.id]);
  const latest = () => {
    setFollowing(true);
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  };
  return (
    <div className="app">
      <a className="skip-link" href="#prompt">
        Skip to composer
      </a>
      <header className="toolbar">
        <h1 ref={heading} tabIndex={-1}>
          Crossbar
        </h1>
        <nav aria-label="Chat actions">
          <button
            disabled={state.busy}
            title="New chat"
            aria-label="New chat"
            onClick={() => post({ type: "new" })}
          >
            ＋
          </button>
          <button
            title="Conversations"
            aria-label="Conversations"
            aria-pressed={panel === "history"}
            onClick={() =>
              setPanel(panel === "history" ? undefined : "history")
            }
          >
            History
          </button>
          <button
            title="Usage and context"
            aria-label="Usage and context"
            onClick={() => setPanel(panel === "usage" ? undefined : "usage")}
          >
            Usage
          </button>
          <button
            title="Provider settings"
            aria-label="Provider settings"
            onClick={() =>
              setPanel(panel === "settings" ? undefined : "settings")
            }
          >
            •••
          </button>
        </nav>
      </header>
      {state.error && (
        <div className="banner error" role="alert">
          {state.error}
        </div>
      )}
      {state.notice && (
        <div className="banner" role="status">
          {state.notice}
        </div>
      )}
      {panel ? (
        <main className="scroll-panel">
          <Panels
            panel={panel}
            state={state}
            close={() => setPanel(undefined)}
          />
        </main>
      ) : (
        <main
          className="transcript"
          ref={scroll}
          onScroll={() => {
            if (scroll.current)
              setFollowing(
                scroll.current.scrollHeight -
                  scroll.current.scrollTop -
                  scroll.current.clientHeight <
                  70,
              );
          }}
          aria-label="Conversation"
        >
          {!state.chat?.messages.length ? (
            <div className="empty">
              <svg
                viewBox="0 0 24 24"
                width="34"
                height="34"
                aria-hidden="true"
              >
                <path d="M3 7h18M3 17h18M8 3v18M16 3v18" />
                <circle cx="8" cy="7" r="2" />
                <circle cx="16" cy="17" r="2" />
              </svg>
              <h2>
                One conversation.
                <br />
                Your coding agents.
              </h2>
              <p>
                Choose a provider, attach the context that matters, and start a
                conversation.
              </p>
              <button onClick={() => setPanel("settings")}>
                Connect your providers
              </button>
              <div className="empty-shortcuts">
                <span>Switch providers without losing context</span>
                <span>Compare answers when you choose</span>
              </div>
            </div>
          ) : (
            <>
              <div className="conversation-title">
                <span>{state.chat.title}</span>
                <button
                  disabled={state.busy}
                  aria-busy={summarising}
                  onClick={() => {
                    const last = state
                      .chat!.messages.filter(
                        (message) => message.provider && message.model,
                      )
                      .at(-1);
                    if (last?.provider && last.model) {
                      setSummarising(true);
                      post({
                        type: "summary",
                        provider: last.provider,
                        model: last.model,
                      });
                    }
                  }}
                >
                  {summarising ? (
                    <>
                      <span className="spinner" aria-hidden="true" />
                      Summarising…
                    </>
                  ) : (
                    "Summarise & continue"
                  )}
                </button>
              </div>
              {state.total > state.chat.messages.length && (
                <button
                  className="load-older"
                  onClick={() => {
                    setFollowing(false);
                    post({
                      type: "older",
                      before: state.total - state.chat!.messages.length,
                    });
                  }}
                >
                  Load earlier messages
                </button>
              )}
              {state.chat.messages.map((message) => {
                const other = message.provider === "codex" ? "claude" : "codex";
                const model = state.providers.find(
                  (provider) => provider.id === other,
                )?.models[0]?.id;
                return (
                  <ChatMessage
                    key={message.id}
                    message={message}
                    busy={state.busy}
                    reviewModel={model ? { provider: other, model } : undefined}
                  />
                );
              })}
            </>
          )}
        </main>
      )}
      {!following && !panel && (
        <button className="jump" onClick={latest}>
          Jump to latest ↓
        </button>
      )}
      <div className="approvals" aria-live="polite">
        {state.approvals.map((approval) => (
          <section key={approval.id} className="approval">
            <strong>
              {approval.provider}: {approval.title}
            </strong>
            <pre>{approval.detail}</pre>
            <div className="row">
              {approval.choices.map((decision) => (
                <button
                  key={decision}
                  className={decision === "deny" ? "" : "primary"}
                  onClick={() =>
                    post({ type: "approve", id: approval.id, decision })
                  }
                >
                  {decision === "allow"
                    ? "Allow once"
                    : decision === "session"
                      ? "Allow for session"
                      : "Deny"}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className="sr-only" role="status">
        {state.busy ? "Generating response" : "Ready"}
      </div>
      <Composer state={state} panel={setPanel} />
    </div>
  );
}
