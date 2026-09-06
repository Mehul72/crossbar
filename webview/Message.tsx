import { Children, isValidElement, memo, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message, ProviderId } from "../src/shared/domain";
import { post } from "./bridge";
function CodeBlock({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children)[0];
  const props = isValidElement<{ children?: ReactNode; className?: string }>(
    child,
  )
    ? child.props
    : undefined;
  const text = typeof props?.children === "string" ? props.children : "";
  return (
    <div className="code-block">
      <div className="code-heading">
        <span>{props?.className?.replace("language-", "") || "code"}</span>
        <button onClick={() => post({ type: "copy", text })}>Copy</button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}
export function RenderMarkdown({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        pre: CodeBlock,
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              if (href) post({ type: "openLink", target: href });
            }}
          >
            {children}
          </a>
        ),
        img: ({ alt }) => (
          <span className="muted">[Image omitted{alt ? `: ${alt}` : ""}]</span>
        ),
      }}
    >
      {text}
    </Markdown>
  );
}
export const ChatMessage = memo(function ChatMessage({
  message,
  busy,
  reviewModel,
}: {
  message: Message;
  busy: boolean;
  reviewModel?: { provider: ProviderId; model: string };
}) {
  const counts = { verified: 0, conflicting: 0, unverified: 0 };
  for (const claim of message.verification) counts[claim.status]++;
  return (
    <article
      className={`message ${message.role}${message.excluded ? " excluded" : ""}`}
      aria-label={
        message.role === "user" ? "You" : `${message.provider} response`
      }
    >
      <header className="message-heading">
        <strong>
          {message.role === "user"
            ? "You"
            : message.provider === "codex"
              ? "Codex"
              : "Claude"}
        </strong>
        {message.model && (
          <span className="muted model-label">{message.model}</span>
        )}
        <span className="message-status">
          {message.status === "streaming"
            ? "Working"
            : message.status === "cancelled"
              ? "Stopped"
              : message.status === "failed"
                ? "Failed"
                : ""}
        </span>
      </header>
      {message.modelReview && (
        <p className="eyebrow">Model review · not objective verification</p>
      )}
      {message.attachments.length > 0 && (
        <div className="message-attachments">
          {message.attachments.map((item) => (
            <details key={item.id}>
              <summary>
                {item.kind === "capsule" ? "Context capsule · " : ""}
                {item.name}
              </summary>
              <pre>{item.content}</pre>
            </details>
          ))}
        </div>
      )}
      <div className="markdown">
        <RenderMarkdown text={message.content} />
      </div>
      {message.tools.length > 0 && (
        <details className="activity">
          <summary>
            {message.tools.length} activities
            {message.tools.some((tool) => tool.status === "running") &&
            message.status === "streaming"
              ? " · running"
              : ""}
          </summary>
          {message.tools.map((tool) => (
            <details key={tool.id} className="tool">
              <summary>
                <span>
                  {tool.status === "completed"
                    ? "✓"
                    : tool.status === "failed"
                      ? "!"
                      : "·"}
                </span>{" "}
                {tool.title}
              </summary>
              {tool.output && <pre>{tool.output}</pre>}
              {tool.exitCode !== undefined && <p>Exit code: {tool.exitCode}</p>}
              {tool.diff && (
                <>
                  <p>
                    {
                      tool.diff
                        .split("\n")
                        .filter((line) => line.startsWith("diff --git")).length
                    }{" "}
                    files · +
                    {
                      tool.diff
                        .split("\n")
                        .filter((line) => /^\+[^+]/.test(line)).length
                    }{" "}
                    −
                    {
                      tool.diff
                        .split("\n")
                        .filter((line) => /^-[^-]/.test(line)).length
                    }
                  </p>
                  <button
                    onClick={() =>
                      post({
                        type: "viewDiff",
                        messageId: message.id,
                        toolId: tool.id,
                      })
                    }
                  >
                    View diff
                  </button>
                  {[...tool.diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(
                    (match) => (
                      <button
                        key={match[1]}
                        onClick={() =>
                          post({ type: "openLink", target: match[1]! })
                        }
                      >
                        {match[1]}
                      </button>
                    ),
                  )}
                </>
              )}
            </details>
          ))}
        </details>
      )}
      {message.error && (
        <div className="message-error" role="status">
          {message.error}
        </div>
      )}
      {message.role === "assistant" && message.status !== "streaming" && (
        <div className="message-footer">
          <details className="verification">
            <summary>
              {message.verification.length
                ? `${counts.verified} verified · ${counts.conflicting} conflicts · ${counts.unverified} unverified`
                : "Not verified"}
            </summary>
            <p>
              Checks cover explicit test, typecheck and lint claims against
              command exit statuses reported in this response. They do not
              measure overall accuracy.
            </p>
            {message.verification.map((claim, index) => (
              <div key={`${claim.claim}-${index}`}>
                <strong>
                  {claim.status}: {claim.claim}
                </strong>
                <pre>{claim.evidence}</pre>
              </div>
            ))}
          </details>
          <button
            className="quiet"
            onClick={() => post({ type: "copy", text: message.content })}
          >
            Copy
          </button>
        </div>
      )}
      {message.compareGroup && message.role === "assistant" && (
        <div className="compare-actions">
          <button
            disabled={busy || message.status !== "completed"}
            onClick={() => post({ type: "choose", messageId: message.id })}
          >
            {message.excluded ? "Use this response" : "Use response"}
          </button>
          {reviewModel && (
            <button
              disabled={busy || message.status !== "completed"}
              onClick={() =>
                post({ type: "review", messageId: message.id, ...reviewModel })
              }
            >
              Ask {reviewModel.provider} to review
            </button>
          )}
          {message.excluded && (
            <span className="muted">Excluded from future context</span>
          )}
        </div>
      )}
    </article>
  );
});
