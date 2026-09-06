import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const directory = resolve(".test-output");
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const capabilities = {
  models: true,
  resume: true,
  quota: true,
  context: true,
  tools: true,
  diffs: true,
  approvals: true,
  cancellation: true,
};
const chat = {
  version: 1,
  id: "4d20be39-34b0-424e-a4c2-a99eae504bd5",
  workspace: "/workspace",
  title: "Review authentication",
  createdAt: 1,
  updatedAt: 1,
  messages: [],
  sessions: [],
  attachments: [],
};
const providers = ["codex", "claude"].map((id) => ({
  id,
  state: "connected",
  detail: "Subscription account",
  models: [
    {
      id: `${id}-test-model`,
      name: id === "codex" ? "Account model" : "Sonnet",
    },
  ],
  capabilities,
}));
const themes = {
  dark: {
    foreground: "#cccccc",
    "sideBar-background": "#181818",
    "editor-background": "#1f1f1f",
    "panel-border": "#454545",
    descriptionForeground: "#aaaaaa",
    "input-background": "#313131",
    "input-foreground": "#cccccc",
    "input-placeholderForeground": "#aaaaaa",
    "button-background": "#0078d4",
    "button-foreground": "#ffffff",
    "button-secondaryBackground": "#313131",
    "button-secondaryForeground": "#cccccc",
    "button-secondaryHoverBackground": "#404040",
    "button-hoverBackground": "#026ec1",
    focusBorder: "#007fd4",
    "textLink-foreground": "#4daafc",
    "textCodeBlock-background": "#252525",
    errorForeground: "#f48771",
    "toolbar-hoverBackground": "#313131",
    "testing-iconPassed": "#89d185",
  },
  light: {
    foreground: "#333333",
    "sideBar-background": "#f8f8f8",
    "editor-background": "#ffffff",
    "panel-border": "#cccccc",
    descriptionForeground: "#616161",
    "input-background": "#ffffff",
    "input-foreground": "#333333",
    "input-placeholderForeground": "#616161",
    "button-background": "#005fb8",
    "button-foreground": "#ffffff",
    "button-secondaryBackground": "#e5e5e5",
    "button-secondaryForeground": "#333333",
    "button-secondaryHoverBackground": "#d5d5d5",
    "button-hoverBackground": "#0058a8",
    focusBorder: "#005fb8",
    "textLink-foreground": "#005fb8",
    "textCodeBlock-background": "#eeeeee",
    errorForeground: "#a1260d",
    "toolbar-hoverBackground": "#e5e5e5",
    "testing-iconPassed": "#287928",
  },
};
const script = await readFile("dist/webview.js", "utf8");
const style = await readFile("dist/webview.css", "utf8");
try {
  for (const [theme, colors] of Object.entries(themes)) {
    const context = await browser.newContext({
      viewport: { width: 360, height: 850 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(
      ({ chat, providers }) => {
        window.__sent = [];
        window.acquireVsCodeApi = () => ({
          getState: () => ({}),
          setState: () => {},
          postMessage: (message) => {
            window.__sent.push(message);
            if (message.type === "ready")
              window.postMessage(
                {
                  type: "state",
                  conversation: chat,
                  history: [],
                  providers,
                  busy: false,
                  approvals: [],
                  totalMessages: 0,
                },
                "*",
              );
          },
        });
      },
      { chat, providers },
    );
    await page.route("https://crossbar.test/**", async (route) => {
      if (route.request().url().endsWith("webview.js"))
        return route.fulfill({
          contentType: "application/javascript",
          body: script,
        });
      if (route.request().url().endsWith("webview.css"))
        return route.fulfill({
          contentType: "text/css",
          body: `:root{${Object.entries(colors)
            .map(([key, value]) => `--vscode-${key}:${value}`)
            .join(";")}}${style}`,
        });
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="en"><head><title>Crossbar UI verification</title><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-test\'; style-src https://crossbar.test; img-src data:;"><link rel="stylesheet" href="/webview.css"></head><body><div id="root"></div><script nonce="test" src="/webview.js"></script></body></html>',
      });
    });
    await page.goto("https://crossbar.test/");
    await page.getByRole("heading", { name: /One conversation/ }).waitFor();
    await page.screenshot({ path: `${directory}/${theme}-empty.png` });
    await page
      .getByRole("textbox", { name: "Message Crossbar" })
      .fill("Explain this function\nKeep it concise.");
    await page
      .getByRole("textbox", { name: "Message Crossbar" })
      .press("Control+Enter");
    const sent = await page.evaluate(() =>
      window.__sent.find((message) => message.type === "send"),
    );
    assert.equal(sent.text, "Explain this function\nKeep it concise.");
    assert.equal(sent.compare, false);
    const user = {
      id: sent.requestId,
      role: "user",
      content: sent.text,
      createdAt: 1,
      status: "completed",
      attachments: [],
      tools: [],
      verification: [],
    };
    const assistant = {
      ...user,
      id: "assistant",
      role: "assistant",
      provider: "codex",
      model: "Account model",
      content:
        "### Authentication flow\n\nThe handler checks the session before reading user data.\n\n```ts\nconst session = await authenticate(request);\n```\n\n| Check | Result |\n| --- | --- |\n| Tests | Passed |\n\n[Open file](src/auth.ts)\n\n<script>window.__injected=true</script>\n\n[Unsafe](javascript:alert(1))",
      tools: [
        {
          id: "test",
          title: "npm test",
          status: "completed",
          command: "npm test",
          exitCode: 0,
          output: "12 tests passed",
        },
      ],
      verification: [
        {
          claim: "Tests passed",
          status: "verified",
          evidence: "npm test exited 0",
        },
      ],
    };
    await page.evaluate(
      ({ id, user, assistant }) => {
        window.postMessage(
          { type: "message", conversationId: id, message: user },
          "*",
        );
        window.postMessage(
          { type: "message", conversationId: id, message: assistant },
          "*",
        );
        window.postMessage({ type: "busy", busy: false }, "*");
      },
      { id: chat.id, user, assistant },
    );
    await page.getByRole("heading", { name: "Authentication flow" }).waitFor();
    assert.equal(
      await page
        .getByRole("textbox", { name: "Message Crossbar" })
        .inputValue(),
      "",
    );
    assert.equal(await page.evaluate(() => window.__injected), undefined);
    assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
    await page
      .locator(".code-heading")
      .getByRole("button", { name: "Copy" })
      .click();
    assert.match(
      await page.evaluate(
        () =>
          window.__sent.filter((message) => message.type === "copy").at(-1)
            .text,
      ),
      /authenticate/,
    );
    await page.screenshot({ path: `${directory}/${theme}-conversation.png` });
    for (const width of [280, 360, 600]) {
      await page.setViewportSize({ width, height: 850 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `${theme} at ${width}px overflowed`,
      );
    }
    await page
      .getByRole("button", { name: "Provider settings", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Providers", exact: true })
      .waitFor();
    const accessibility = await new AxeBuilder({ page }).analyze();
    assert.deepEqual(
      accessibility.violations.map((item) => ({
        id: item.id,
        nodes: item.nodes.map((node) => node.target),
      })),
      [],
      "Accessibility violations",
    );
    await page.getByRole("button", { name: "Close panel" }).click();
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await page
      .getByText("Sends to both providers and uses both quotas.")
      .waitFor();
    await page.evaluate(() =>
      window.postMessage({ type: "busy", busy: true }, "*"),
    );
    await page.getByRole("button", { name: "Stop", exact: true }).waitFor();
    await page
      .getByRole("textbox", { name: "Message Crossbar" })
      .press("Escape");
    await page.waitForFunction(() => window.__sent.at(-1)?.type === "stop");
    assert.equal(await page.evaluate(() => window.__sent.at(-1).type), "stop");
    await page.evaluate(() =>
      window.postMessage(
        {
          type: "approval",
          approval: {
            id: "approval-1",
            provider: "codex",
            title: "Run tests",
            detail: "npm test",
            choices: ["allow", "deny"],
          },
        },
        "*",
      ),
    );
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__sent.at(-1)), {
      type: "approve",
      id: "approval-1",
      decision: "deny",
    });
    assert.deepEqual(errors, []);
    await context.close();
    process.stdout.write(
      `${theme}: rendering, keyboard send/stop, compare, approvals, safe Markdown, copy, narrow layout and axe passed\n`,
    );
  }
} finally {
  await browser.close();
}
