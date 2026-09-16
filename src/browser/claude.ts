import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import type { BrowserLogger, BrowserRunOptions, BrowserRunResult, ChromeClient } from "./types.js";
import { CLAUDE_BROWSER_MODEL } from "./provider.js";
import { getOracleHomeDir } from "../oracleHome.js";
import { resolveBrowserConfig } from "./config.js";
import { resolveAttachRunningConnection } from "./attachRunning.js";
import {
  connectToRemoteChrome,
  connectToRemoteChromeTarget,
  connectWithNewTab,
} from "./chromeLifecycle.js";
import { browserPromptFingerprint } from "./promptFingerprint.js";
import { estimateTokenCount, delay } from "./utils.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { BrowserCancellation, withoutBrowserCancellation } from "./cancellation.js";

const NEW_CHAT = "https://claude.ai/new";
const MODEL_LABEL = "Fable 5.1";
const MODEL_SELECTOR = '[data-testid="model-selector-dropdown"]';
const INPUT_SELECTOR = '[data-testid="chat-input"][contenteditable="true"]';
const ROW_SELECTOR = '[data-testid="transcript-row"]';

export function claudeConversationId(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.origin !== "https://claude.ai" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
    return /^\/chat\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.exec(url.pathname)?.[1];
  } catch {
    return undefined;
  }
}

export interface ClaudeSnapshot {
  url: string;
  modelLabel: string;
  ready: boolean;
  draft: string;
  userIndex: string | null;
  userText: string;
  assistantIndex: string | null;
  answerText: string;
  complete: boolean;
  notices: string;
  title: string;
  assistantCount: number;
  sendExists: boolean;
  focused: boolean;
  visibilityState: string;
}

// Only provider-rendered controls establish identity, effort and completion.
export const CLAUDE_SNAPSHOT_EXPRESSION = `(() => {
  const main = document.querySelector('main');
  const rows = Array.from(main?.querySelectorAll('${ROW_SELECTOR}') || []);
  const user = rows.filter(row => row.getAttribute('data-perf-row') === 'human').at(-1);
  const assistant = rows.filter(row => row.getAttribute('data-perf-row') === 'assistant').at(-1);
  const editor = main?.querySelector('${INPUT_SELECTOR}');
  const reply = assistant?.querySelector('.standard-markdown');
  const afterUser = !!user && !!assistant && Number(assistant.dataset.index) > Number(user.dataset.index);
  return {
    url: location.href, title: document.title,
    assistantCount: rows.filter(row => row.getAttribute('data-perf-row') === 'assistant').length,
    sendExists: !!main?.querySelector('[data-testid="chat-input-send"]'),
    focused: document.hasFocus(), visibilityState: document.visibilityState,
    modelLabel: main?.querySelector('${MODEL_SELECTOR}')?.getAttribute('aria-label') || '',
    ready: !!editor,
    draft: editor?.innerText || '',
    userIndex: user?.getAttribute('data-index') ?? null,
    userText: user?.querySelector('[data-testid="user-message"]')?.innerText || '',
    assistantIndex: assistant?.getAttribute('data-index') ?? null,
    answerText: reply?.innerText || '',
    complete: afterUser && !!reply?.textContent?.trim() &&
      assistant?.getAttribute('data-perf-row-streaming') === 'false' &&
      !!assistant.querySelector('[data-is-streaming="false"]') &&
      !!assistant.querySelector('[data-testid="action-bar-copy"]'),
    notices: Array.from(main?.querySelectorAll('[role="alert"], [role="status"]') || [])
      .map(el => el.innerText || '').join('\\n')
  };
})()`;

export function assertClaudeSelection(
  snapshot: Pick<ClaudeSnapshot, "url" | "modelLabel" | "notices">,
): void {
  if (snapshot.url !== NEW_CHAT && !claudeConversationId(snapshot.url)) {
    throw new Error(
      "Claude is not in an authenticated, standalone chat. Sign in and retry; no prompt was replayed.",
    );
  }
  if (!/^Model: Fable 5\.1 Max(?:\s|$)/.test(snapshot.modelLabel)) {
    throw new Error(
      `Claude selection is not Fable 5.1 Max (${snapshot.modelLabel || "unavailable"}); refusing to continue.`,
    );
  }
  if (
    /usage limit|limit reached|out of messages|switched to|switching to|try again|something went wrong|failed to send/i.test(
      snapshot.notices,
    )
  ) {
    throw new Error(
      `Claude reported a quota, model switch, or generation failure: ${snapshot.notices.slice(0, 400)}`,
    );
  }
}

export function claudePromptHash(snapshot: ClaudeSnapshot): string | undefined {
  const id = claudeConversationId(snapshot.url);
  if (!id || snapshot.userIndex == null || !snapshot.userText.trim()) return undefined;
  return browserPromptFingerprint(snapshot.userText, `${id}:${snapshot.userIndex}`);
}

export function assertClaudeAnswer(snapshot: ClaudeSnapshot, expectedHash: string): void {
  assertClaudeSelection(snapshot);
  if (claudePromptHash(snapshot) !== expectedHash)
    throw new Error(
      "Claude user turn differs from the saved prompt; refusing to capture stale output.",
    );
  if (!snapshot.complete) throw new Error("Claude answer is not complete.");
}

async function evaluate<T>(client: ChromeClient, expression: string): Promise<T> {
  const result = await client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value as T;
}

async function waitFor<T>(
  read: () => Promise<T | undefined | false>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    await delay(300);
  } while (Date.now() < deadline);
  throw new Error(
    `Claude timed out waiting for ${description}. Keep the existing conversation; do not resubmit.`,
  );
}

async function click(client: ChromeClient, selector: string): Promise<void> {
  const clicked = await evaluate<boolean>(
    client,
    `(() => {
    const matches = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(el => el.getClientRects().length);
    if (matches.length !== 1) return false;
    const el = matches[0];
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled')) return false;
    el.click(); return true;
  })()`,
  );
  if (!clicked) throw new Error(`Claude control is missing, ambiguous, or disabled: ${selector}`);
}

async function selectClaude(client: ChromeClient, timeoutMs: number): Promise<ClaudeSnapshot> {
  await click(client, MODEL_SELECTOR);
  const model = `[role="menuitemradio"][data-model-id="${CLAUDE_BROWSER_MODEL}"]`;
  await waitFor(
    () => evaluate<boolean>(client, `!!document.querySelector('${model}')`),
    timeoutMs,
    MODEL_LABEL,
  );
  await click(client, model);
  await waitFor(
    () =>
      evaluate<boolean>(
        client,
        `document.querySelector('${MODEL_SELECTOR}')?.getAttribute('aria-label')?.startsWith('Model: Fable 5.1 ') && document.querySelector('${MODEL_SELECTOR}')?.getAttribute('aria-expanded') === 'false'`,
      ),
    timeoutMs,
    "selected model",
  );
  await click(client, MODEL_SELECTOR);
  const effortOpened = await evaluate<boolean>(
    client,
    `(() => {
    const items = Array.from(document.querySelectorAll('[role="menuitem"]')).filter(el => /^Effort\\b/.test(el.innerText) && el.getClientRects().length);
    if (items.length !== 1) return false; items[0].click(); return true;
  })()`,
  );
  if (!effortOpened) throw new Error("Claude Effort menu is unavailable.");
  const max = '[role="menuitemradio"][data-effort-id="max"]';
  await waitFor(
    () => evaluate<boolean>(client, `!!document.querySelector('${max}')`),
    timeoutMs,
    "Max effort option",
  );
  await click(client, max);
  // Close any remaining menu without touching the composer.
  await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Escape", code: "Escape" });
  await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", code: "Escape" });
  const selected = await waitFor(
    async () => {
      const snapshot = await evaluate<ClaudeSnapshot>(client, CLAUDE_SNAPSHOT_EXPRESSION);
      return /^Model: Fable 5\.1 Max(?:\s|$)/.test(snapshot.modelLabel) ? snapshot : undefined;
    },
    timeoutMs,
    "verified Fable 5.1 Max",
  );
  assertClaudeSelection(selected);
  return selected;
}

async function disableClaudeTools(client: ChromeClient): Promise<void> {
  const closeMenus = async () => {
    await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Escape", code: "Escape" });
    await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", code: "Escape" });
    await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Escape", code: "Escape" });
    await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", code: "Escape" });
  };
  for (const connectors of [false, true]) {
    let cleared = false;
    for (let remaining = 50; remaining > 0; remaining--) {
      await closeMenus();
      await click(client, '[data-testid="chat-input-attach"]');
      await waitFor(
        () =>
          evaluate<boolean>(client, "!!document.querySelector('[data-testid=add-menu-research]')"),
        5000,
        "chat tools menu",
      );
      if (connectors) {
        const available = await evaluate<boolean>(
          client,
          "!!document.querySelector('[data-testid=add-menu-connectors]')",
        );
        if (!available) {
          cleared = true;
          break;
        }
        await click(client, '[data-testid="add-menu-connectors"]');
        await delay(200);
      }
      const changed = await evaluate<boolean>(
        client,
        `(() => {
        const selected = Array.from(document.querySelectorAll('[role="menuitemcheckbox"][aria-checked="true"]')).find(el => el.getClientRects().length);
        if (!selected) return false;
        if (selected.getAttribute('aria-disabled') === 'true') throw new Error('Enabled Claude tool cannot be disabled');
        selected.click(); return true;
      })()`,
      );
      if (!changed) {
        cleared = true;
        break;
      }
      await delay(200);
    }
    if (!cleared) throw new Error("Could not disable Claude's per-chat tools and connectors.");
  }
  await closeMenus();
}

async function copyClaudeTurn(
  client: ChromeClient,
  snapshot: ClaudeSnapshot,
  role: "user" | "assistant",
): Promise<string> {
  const index = role === "user" ? snapshot.userIndex : snapshot.assistantIndex;
  const copyId = role === "user" ? "user-message-copy" : "action-bar-copy";
  if (!/^\d+$/.test(index ?? "")) throw new Error("Claude message row identity is unavailable.");
  const result = await evaluate<string>(
    client,
    `(async () => {
    if (location.href !== ${JSON.stringify(snapshot.url)}) throw new Error('Claude conversation changed before copy');
    const row = document.querySelector('${ROW_SELECTOR}[data-index="${index}"]');
    const button = row?.querySelector('[data-testid="${copyId}"]');
    if (!button || !navigator.clipboard) throw new Error('Claude message copy control unavailable');
    const clipboard = navigator.clipboard;
    const oldWrite = clipboard.write, oldWriteText = clipboard.writeText;
    let text;
    try {
      clipboard.writeText = async value => { text = value; };
      clipboard.write = async items => {
        for (const item of items) if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
      };
      button.click();
      const deadline = Date.now() + 5000;
      while (text === undefined && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (!text?.trim()) throw new Error('Claude source copy failed; refusing rendered-text fallback');
      return text;
    } finally { clipboard.write = oldWrite; clipboard.writeText = oldWriteText; }
  })()`,
  );
  return result;
}

// The transcript renders Markdown; fingerprint the original user text from Copy.
async function readClaudeSourceSnapshot(client: ChromeClient): Promise<ClaudeSnapshot> {
  const before = await evaluate<ClaudeSnapshot>(client, CLAUDE_SNAPSHOT_EXPRESSION);
  const source = await copyClaudeTurn(client, before, "user");
  const after = await evaluate<ClaudeSnapshot>(client, CLAUDE_SNAPSHOT_EXPRESSION);
  if (
    after.url !== before.url ||
    after.userIndex !== before.userIndex ||
    after.userText !== before.userText
  )
    throw new Error("Claude user turn changed while copying its source.");
  return { ...after, userText: source };
}

export function buildClaudePromptInsertExpression(prompt: string): string {
  return `(() => {
    const editor = document.querySelector('${INPUT_SELECTOR}');
    if (!editor || editor.innerText.trim()) throw new Error('Claude composer is missing or not empty');
    editor.focus();
    const escaped = document.createElement('div');
    escaped.textContent = ${JSON.stringify(prompt.replace(/\r\n?/g, "\n"))};
    // Native multiline insertText creates blocks whose innerText gains extra newlines.
    // Soft breaks preserve blank lines and code indentation in the rich-text editor.
    if (!document.execCommand('insertHTML', false, escaped.innerHTML.replace(/\\n/g, '<br>')))
      throw new Error('Claude text insertion failed');
  })()`;
}

function validateOptions(options: BrowserRunOptions): void {
  const config = options.config ?? {};
  if (options.model && options.model !== CLAUDE_BROWSER_MODEL)
    throw new Error("Only claude-fable-5-1 is supported by the Claude browser driver.");
  if (config.thinkingTime && config.thinkingTime !== "max")
    throw new Error("Fable 5.1 browser runs require Max effort.");
  if (config.desiredModel && config.desiredModel !== MODEL_LABEL)
    throw new Error("Fable 5.1 browser runs require the exact model label.");
  if (config.modelStrategy && config.modelStrategy !== "select")
    throw new Error("Claude requires --browser-model-strategy select.");
  if (config.researchMode && config.researchMode !== "off")
    throw new Error("Claude research modes are not supported.");
  if (
    config.url ||
    config.chatgptUrl ||
    config.browserTabRef ||
    config.captureProviderNative ||
    config.copyProfileSource ||
    config.cookieSync ||
    config.inlineCookies?.length
  ) {
    throw new Error(
      "Claude requires a fresh standalone chat using manual login or attach-running; URL/tab overrides, profile copying, cookie injection and native capture are not supported.",
    );
  }
  if (config.archiveConversations === "always")
    throw new Error("Claude automatic archiving is not supported.");
  if (options.attachments?.length || options.generateImagePath || options.followUpPrompts?.length) {
    throw new Error(
      "Claude accepts text evidence inline (--browser-attachments never). Use --followup for additional turns; uploads, image generation and queued follow-ups are not supported.",
    );
  }
  if (config.resumeConversationUrl && !claudeConversationId(config.resumeConversationUrl))
    throw new Error("Invalid Claude conversation URL.");
}

async function openClaude(options: BrowserRunOptions, runtime?: BrowserRuntimeMetadata) {
  const log = options.log ?? (() => {});
  const config = resolveBrowserConfig({ ...options.config, manualLogin: true });
  const profileDir =
    options.config?.manualLoginProfileDir ??
    path.join(getOracleHomeDir(), "claude-browser-profile");
  let host = runtime?.chromeHost ?? "127.0.0.1";
  let port = runtime?.chromePort;
  let browserWSEndpoint = runtime?.chromeBrowserWSEndpoint;
  let profileRoot = runtime?.chromeProfileRoot;
  let chromePid = runtime?.chromePid;
  if (!port) {
    if (config.attachRunning || config.remoteChrome) {
      const endpoint = await resolveAttachRunningConnection(config, log);
      ({ host, port, browserWSEndpoint } = endpoint);
      profileRoot = endpoint.profileRoot ?? undefined;
    } else {
      await mkdir(profileDir, { recursive: true });
      const { acquireManualLoginChromeForRun } = await import("./index.js");
      const { chrome } = await acquireManualLoginChromeForRun(
        profileDir,
        config,
        log,
        options.sessionId,
      );
      port = chrome.port;
      chromePid = chrome.pid;
      // The persistent browser must survive a timeout and controller exit.
      chrome.process?.unref();
    }
  }
  const connection = runtime?.chromeTargetId
    ? await connectToRemoteChromeTarget(host, port, log, {
        targetId: runtime.chromeTargetId,
        browserWSEndpoint,
        closeTargetOnDispose: false,
        approvalWaitMs: config.approvalWaitMs,
      })
    : browserWSEndpoint
      ? await connectToRemoteChrome(host, port, log, "about:blank", browserWSEndpoint, {
          approvalWaitMs: config.approvalWaitMs,
          fallbackToDefault: false,
        })
      : await connectWithNewTab(port, log, undefined, host, { fallbackToDefault: false });
  const hints: BrowserRuntimeMetadata = {
    browserTransport: "cdp",
    chromeHost: host,
    chromePort: port,
    chromeBrowserWSEndpoint: browserWSEndpoint,
    chromeProfileRoot: profileRoot,
    chromePid,
    userDataDir: profileRoot ?? profileDir,
    chromeTargetId: connection.targetId,
    promptSubmitted: false,
    submittedPromptHash: null,
  };
  return { ...connection, hints };
}

export async function runClaudeBrowser(options: BrowserRunOptions): Promise<BrowserRunResult> {
  validateOptions(options);
  const log = options.log ?? (() => {});
  const cancellation = new BrowserCancellation(options.signal, log);
  let connection: Awaited<ReturnType<typeof openClaude>> | undefined;
  const started = Date.now();
  let hints: BrowserRuntimeMetadata = {};
  let complete = false;
  try {
    return await cancellation.run(async () => {
      connection = await cancellation.acquire(
        () => openClaude(options),
        (c) => c.client.close(),
      );
      const client = cancellation.client(connection.client);
      hints = connection.hints;
      await options.runtimeHintCb?.(hints);
      await client.Runtime.enable();
      await client.Page.enable();
      await client.Page.navigate({ url: options.config?.resumeConversationUrl ?? NEW_CHAT });
      const inputTimeout = options.config?.inputTimeoutMs ?? 60_000;
      await waitFor(
        async () => (await evaluate<ClaudeSnapshot>(client, CLAUDE_SNAPSHOT_EXPRESSION)).ready,
        inputTimeout,
        "signed-in Claude composer (sign in in the opened tab if needed)",
      );
      let snapshot = await selectClaude(client, inputTimeout);
      await disableClaudeTools(client);
      snapshot = await evaluate<ClaudeSnapshot>(client, CLAUDE_SNAPSHOT_EXPRESSION);
      assertClaudeSelection(snapshot);
      if (snapshot.draft.trim())
        throw new Error("Claude composer contains an existing draft; refusing to overwrite it.");
      const baseline = snapshot.userIndex;
      const selectedAt = new Date().toISOString();
      const modelSelection = {
        requestedModel: MODEL_LABEL,
        resolvedLabel: snapshot.modelLabel.replace(/^Model: /, ""),
        strategy: "select" as const,
        status: "switched" as const,
        verified: true,
        source: "claude-model-picker" as const,
        capturedAt: selectedAt,
      };
      const thinkingSelection = {
        requestedLevel: "max" as const,
        status: "switched" as const,
        resolvedLabel: "Max",
        verified: true,
        strictFailClosed: true,
        source: "claude-effort-picker" as const,
        capturedAt: selectedAt,
      };
      hints.tabUrl = snapshot.url;
      hints.conversationId = claudeConversationId(snapshot.url);
      await options.runtimeHintCb?.(hints, modelSelection);
      log("[browser] Model selection: verified Fable 5.1; thinking effort: verified Max.");
      await evaluate(client, buildClaudePromptInsertExpression(options.prompt));
      snapshot = await evaluate<ClaudeSnapshot>(client, CLAUDE_SNAPSHOT_EXPRESSION);
      assertClaudeSelection(snapshot);
      if (
        snapshot.draft.replace(/\r\n?/g, "\n").trim() !==
        options.prompt.replace(/\r\n?/g, "\n").trim()
      )
        throw new Error(
          "Claude composer does not contain the complete reviewed prompt; refusing to send.",
        );
      // Persist send intent first. Any ambiguity after this point is recovered, never retried.
      hints.promptSubmitted = true;
      await options.runtimeHintCb?.(hints, modelSelection);
      await click(client, '[data-testid="chat-input-send"]');
      snapshot = await waitFor(
        async () => {
          const current = await evaluate<ClaudeSnapshot>(client, CLAUDE_SNAPSHOT_EXPRESSION);
          assertClaudeSelection(current);
          if (
            current.userIndex == null ||
            current.userIndex === baseline ||
            !claudeConversationId(current.url)
          )
            return undefined;
          const committed = await readClaudeSourceSnapshot(client);
          if (
            committed.userText.replace(/\r\n?/g, "\n").trim() !==
            options.prompt.replace(/\r\n?/g, "\n").trim()
          )
            throw new Error(
              "Claude committed prompt differs from the reviewed source; preserve this turn without resubmitting.",
            );
          return committed;
        },
        inputTimeout,
        "committed user turn",
      );
      hints = {
        ...hints,
        tabUrl: snapshot.url,
        conversationId: claudeConversationId(snapshot.url),
        submittedPromptHash: claudePromptHash(snapshot),
      };
      await options.runtimeHintCb?.(hints, modelSelection);
      snapshot = await waitForAnswer(client, hints, options.config?.timeoutMs ?? 1_200_000);
      const answerMarkdown = await copyClaudeTurn(client, snapshot, "assistant");
      assertClaudeAnswer(await readClaudeSourceSnapshot(client), hints.submittedPromptHash!);
      complete = true;
      return {
        ...hints,
        answerText: snapshot.answerText,
        answerMarkdown,
        modelSelection,
        thinkingSelection,
        tookMs: Date.now() - started,
        answerChars: answerMarkdown.length,
        answerTokens: estimateTokenCount(answerMarkdown),
      };
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new BrowserAutomationError(
      error instanceof Error ? error.message : String(error),
      { stage: "claude-browser", runtime: hints },
      error,
    );
  } finally {
    if (connection) {
      // Never close an incomplete tab, and never close the user's browser process.
      if (complete && !options.config?.keepBrowser && connection.targetId) {
        await withoutBrowserCancellation(() =>
          connection!.client.Target.closeTarget({ targetId: connection!.targetId! }),
        ).catch(() => undefined);
      }
      await withoutBrowserCancellation(() => connection!.client.close()).catch(() => undefined);
    }
    cancellation.dispose();
  }
}

async function waitForAnswer(
  client: ChromeClient,
  runtime: BrowserRuntimeMetadata,
  timeoutMs: number,
): Promise<ClaudeSnapshot> {
  const hash = runtime.submittedPromptHash;
  if (!hash || !claudeConversationId(runtime.tabUrl))
    throw new Error(
      "Claude submission identity is incomplete; inspect the preserved tab without resubmitting.",
    );
  return waitFor(
    async () => {
      const snapshot = await evaluate<ClaudeSnapshot>(client, CLAUDE_SNAPSHOT_EXPRESSION);
      assertClaudeSelection(snapshot);
      if (snapshot.url !== runtime.tabUrl)
        throw new Error("Claude conversation changed; refusing to capture another chat.");
      if (!snapshot.complete) return undefined;
      const source = await readClaudeSourceSnapshot(client);
      assertClaudeAnswer(source, hash);
      return source;
    },
    timeoutMs,
    "complete Claude answer",
  );
}

export async function resumeClaudeBrowser(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  log: BrowserLogger,
  signal?: AbortSignal,
): Promise<BrowserRunResult & { claudeSnapshot: ClaudeSnapshot }> {
  if (!claudeConversationId(runtime.tabUrl) || !runtime.submittedPromptHash)
    throw new Error(
      "Claude recovery needs the saved conversation URL and committed prompt fingerprint.",
    );
  const cancellation = new BrowserCancellation(signal, log);
  let connection: Awaited<ReturnType<typeof openClaude>> | undefined;
  const started = Date.now();
  try {
    return await cancellation.run(async () => {
      const options: BrowserRunOptions = {
        prompt: "",
        model: CLAUDE_BROWSER_MODEL,
        config,
        log,
        signal,
      };
      try {
        connection = await cancellation.acquire(
          () => openClaude(options, runtime),
          (c) => c.client.close(),
        );
      } catch {
        cancellation.check();
        // A closed tab can be reopened only at its saved, validated conversation URL.
        log("[browser] Reopening saved Claude conversation; no prompt will be submitted.");
        connection = await cancellation.acquire(
          () => openClaude(options),
          (c) => c.client.close(),
        );
      }
      const client = cancellation.client(connection.client);
      await client.Runtime.enable();
      const currentUrl = await evaluate<string>(client, "location.href");
      if (currentUrl === "about:blank") await client.Page.navigate({ url: runtime.tabUrl! });
      else if (currentUrl !== runtime.tabUrl)
        throw new Error(
          "Saved Claude target now belongs to another page; refusing to navigate it.",
        );
      await waitFor(
        async () => {
          const snapshot = await evaluate<ClaudeSnapshot>(client, CLAUDE_SNAPSHOT_EXPRESSION);
          return (
            snapshot.ready &&
            snapshot.userIndex != null &&
            /^Model: Fable 5\.1 Max(?:\s|$)/.test(snapshot.modelLabel)
          );
        },
        config?.inputTimeoutMs ?? 60_000,
        "saved Claude turn and Fable 5.1 Max selection",
      );
      const snapshot = await waitForAnswer(client, runtime, config?.timeoutMs ?? 120_000);
      const answerMarkdown = await copyClaudeTurn(client, snapshot, "assistant");
      assertClaudeAnswer(await readClaudeSourceSnapshot(client), runtime.submittedPromptHash!);
      return {
        claudeSnapshot: snapshot,
        ...runtime,
        ...connection.hints,
        promptSubmitted: true,
        submittedPromptHash: runtime.submittedPromptHash,
        tabUrl: snapshot.url,
        conversationId: claudeConversationId(snapshot.url),
        answerText: snapshot.answerText,
        answerMarkdown,
        tookMs: Date.now() - started,
        answerChars: answerMarkdown.length,
        answerTokens: estimateTokenCount(answerMarkdown),
      };
    });
  } finally {
    if (connection)
      await withoutBrowserCancellation(() => connection!.client.close()).catch(() => undefined);
    cancellation.dispose();
  }
}
