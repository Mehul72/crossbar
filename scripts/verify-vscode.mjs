import { _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const artifacts = resolve(".test-output");
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(join(artifacts, "vscode-"));
await mkdir(join(profile, "User"), { recursive: true });
// Runtimes are not always on PATH, so honour the same overrides runtime-check.mjs takes.
const settings = {
  "telemetry.telemetryLevel": "off",
  "workbench.startupEditor": "none",
  "chat.disableAIFeatures": true,
  "workbench.colorTheme": "Default Dark Modern",
  // Native macOS menus are outside the browser automation DOM.
  "window.menuStyle": "custom",
  ...(process.env.CROSSBAR_CODEX_PATH
    ? { "crossbar.codexPath": process.env.CROSSBAR_CODEX_PATH }
    : {}),
  ...(process.env.CROSSBAR_CLAUDE_PATH
    ? { "crossbar.claudePath": process.env.CROSSBAR_CLAUDE_PATH }
    : {}),
};
await writeFile(
  join(profile, "User", "settings.json"),
  JSON.stringify(settings),
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath:
    process.env.CROSSBAR_VSCODE_EXECUTABLE ||
    "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
  args: [
    `--user-data-dir=${profile}`,
    `--extensions-dir=${join(profile, "extensions")}`,
    `--extensionDevelopmentPath=${process.cwd()}`,
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-updates",
    "--new-window",
    process.cwd(),
  ],
  env,
  timeout: 60_000,
});
try {
  const window = await app.firstWindow({ timeout: 60_000 });
  await window.waitForLoadState("domcontentloaded");
  await window
    .locator(".monaco-workbench .part.sidebar")
    .waitFor({ state: "visible", timeout: 30000 });
  await window.screenshot({ path: join(artifacts, "vscode-initial.png") });
  // The palette indexes a command only after VS Code loads the extension, and it
  // does not re-filter a list that grew while open, so reopen it until the row exists.
  const palette =
    process.platform === "darwin" ? "Meta+Shift+P" : "Control+Shift+P";
  const command = window
    .locator(".quick-input-list .monaco-list-row")
    .filter({ hasText: "Crossbar: Open Chat" })
    .first();
  let listed = false;
  for (let attempt = 0; attempt < 30 && !listed; attempt++) {
    await window.keyboard.press("Escape");
    await window.keyboard.press(palette);
    await window
      .locator(".quick-input-widget input")
      .fill(">Crossbar: Open Chat");
    listed = await command
      .waitFor({ state: "visible", timeout: 2000 })
      .then(() => true)
      .catch(() => false);
  }
  if (!listed) throw new Error("Crossbar commands were never registered");
  await window.keyboard.press("Enter");
  await window.waitForFunction(
    () => [...document.querySelectorAll("iframe")].length > 0,
    { timeout: 30000 },
  );
  let chatFrame;
  for (let attempt = 0; attempt < 50; attempt++) {
    chatFrame = window
      .frames()
      .find(
        (frame) =>
          frame.url().includes("webview") &&
          !frame.url().includes("index.html"),
      );
    if (chatFrame && (await chatFrame.locator("#prompt").count())) break;
    await window.waitForTimeout(200);
  }
  if (!chatFrame || !(await chatFrame.locator("#prompt").count()))
    throw new Error("Crossbar webview did not initialize");
  await chatFrame
    .getByRole("button", { name: "Provider settings", exact: true })
    .click();
  // The view is contributed to the secondary sidebar, so it must render there and
  // not fall back to the activity bar.
  // Webview iframes render in an overlay outside the part DOM, so identify the host
  // container by the view title the part itself renders.
  const container = await window.evaluate(() =>
    (
      document.querySelector(".part.auxiliarybar")?.textContent ?? ""
    ).toLowerCase(),
  );
  if (!container.includes("crossbar"))
    throw new Error(
      `Crossbar did not open in the secondary sidebar. It showed: ${container.slice(0, 200)}`,
    );
  // Account state depends on the machine, so assert the host wired both cards through
  // to a real runtime verdict. Live account checks belong to runtime-check.mjs.
  const states = ["connected", "disconnected", "missing", "error"];
  for (const provider of ["Codex", "Claude"]) {
    const card = chatFrame
      .locator(".provider-card")
      .filter({ has: chatFrame.getByRole("heading", { name: provider }) });
    await card.waitFor({ timeout: 30000 });
    const text = await card.innerText();
    if (!states.some((state) => text.includes(state)))
      throw new Error(`${provider} card reported no runtime state: ${text}`);
  }
  await chatFrame.getByRole("button", { name: "Close panel" }).click();
  await window.keyboard.press(
    process.platform === "darwin" ? "Meta+p" : "Control+p",
  );
  await window.locator(".quick-input-widget input").fill(resolve("README.md"));
  await window
    .locator(".quick-input-list .monaco-list-row")
    .filter({ hasText: "README.md" })
    .first()
    .click();
  const editor = window.locator(".monaco-editor .view-lines").first();
  await editor.waitFor({ state: "visible" });
  await editor.click({ position: { x: 80, y: 10 } });
  await window.keyboard.press(
    process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home",
  );
  await window.keyboard.press("Shift+ArrowDown");
  await window
    .locator(".monaco-editor .view-line")
    .first()
    .click({ button: "right", position: { x: 40, y: 8 } });
  const addSelection = window.getByRole("menuitem", {
    name: "Add to Crossbar chat",
    exact: true,
  });
  await addSelection.waitFor({ state: "visible" });
  await addSelection.hover();
  await window.keyboard.press("Enter");
  await chatFrame
    .locator(".attachment summary")
    .filter({ hasText: "README.md:" })
    .waitFor();
  await chatFrame.locator(".composer").evaluate((element, file) => {
    const dataTransfer = new window.DataTransfer();
    dataTransfer.setData("text/uri-list", "file://" + encodeURI(file));
    element.dispatchEvent(
      new window.DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }),
    );
  }, resolve("README.md"));
  await chatFrame
    .locator(".attachment summary")
    .filter({ hasText: /^README.md$/ })
    .waitFor();
  await window.screenshot({
    path: join(artifacts, "vscode-crossbar-dark.png"),
  });
  await writeFile(
    join(artifacts, "vscode-dom.txt"),
    await window.locator("body").innerText(),
  );
  await writeFile(
    join(profile, "User", "settings.json"),
    JSON.stringify({
      ...settings,
      "workbench.colorTheme": "Default Light Modern",
    }),
  );
  await window.locator(".monaco-workbench.vs").waitFor({ timeout: 15000 });
  await window.screenshot({
    path: join(artifacts, "vscode-crossbar-light.png"),
  });
  const frames = window.frames();
  process.stdout.write(
    JSON.stringify({
      frames: frames.map((frame) => frame.url().split("?")[0]),
      profile,
    }) + "\n",
  );
} catch (error) {
  const active = await app.firstWindow();
  await active.screenshot({ path: join(artifacts, "vscode-failure.png") });
  await writeFile(
    join(artifacts, "vscode-failure.txt"),
    await active.locator("body").innerText(),
  );
  for (const frame of active.frames()) {
    if (await frame.locator("#prompt").count())
      await writeFile(
        join(artifacts, "vscode-webview-failure.txt"),
        await frame.locator("body").innerText(),
      );
  }
  throw error;
} finally {
  const timer = setTimeout(() => app.process().kill("SIGTERM"), 10_000);
  try {
    await app.close();
  } finally {
    clearTimeout(timer);
  }
}
