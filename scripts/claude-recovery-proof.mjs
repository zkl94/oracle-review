#!/usr/bin/env node
// Real, isolated Chrome with a synthetic page; no provider traffic or account.
import assert from "node:assert/strict";
import { launch } from "chrome-launcher";
import puppeteer from "puppeteer-core";
import {
  CLAUDE_SNAPSHOT_EXPRESSION,
  assertClaudeAnswer,
  buildClaudePromptInsertExpression,
  claudePromptHash,
  resumeClaudeBrowser,
} from "../dist/src/browser/claude.js";

const url = "https://claude.ai/chat/12345678-1234-1234-1234-123456789abc";
const userSource = "Review this patch.\n\n```js\n  const value = 1;\n```";
const markdown = "# Answer\n\n- alpha\n- beta\n\n```js\nconst ok = true;\n```";
const chrome = await launch({
  chromePath: process.env.CHROME_PATH,
  chromeFlags: ["--headless=new", "--no-first-run", "--no-default-browser-check"],
});
let browser;
try {
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}` });
  const peer = await browser.newPage();
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on(
    "request",
    (request) =>
      void request.respond({
        contentType: "text/html",
        body: `<!doctype html><title>Claude recovery proof</title><main>
      <button data-testid="model-selector-dropdown" aria-label="Model: Fable 5.1 Max"></button>
      <div data-testid="transcript-row" data-index="0" data-perf-row="human">
        <div data-testid="user-message"><p>Review this patch.</p><code>  const value = 1;</code></div>
        <button data-testid="user-message-copy" onclick='navigator.clipboard.writeText(${JSON.stringify(userSource)})'>Copy</button></div>
      <div data-testid="transcript-row" data-index="1" data-perf-row="assistant" data-perf-row-streaming="false">
        <div data-is-streaming="false"><div class="standard-markdown"><h1>Answer</h1><ul><li>alpha</li><li>beta</li></ul><pre>const ok = true;</pre></div></div>
        <button data-testid="action-bar-copy" onclick='navigator.clipboard.writeText(${JSON.stringify(markdown)})'>Copy</button></div>
      <div data-testid="chat-input" contenteditable="true" style="white-space:pre-wrap"></div>
      <button data-testid="chat-input-send" onclick="window.sends++">Send</button>
      <script>window.sends = 0;</script></main>`,
      }),
  );
  await page.goto(url);
  const snapshot = () => page.evaluate(CLAUDE_SNAPSHOT_EXPRESSION);
  const prompt = '# Review\n\n```py\n  value = "<literal>&value"\n\n  return value\n```';
  const input = await page.createCDPSession();
  await page.focus('[data-testid="chat-input"]');
  await input.send("Input.insertText", { text: prompt });
  assert.notEqual(
    (await snapshot()).draft,
    prompt,
    "native multiline input must reproduce the extra-newline regression",
  );
  await page.reload();
  await page.evaluate(buildClaudePromptInsertExpression(prompt));
  assert.equal((await snapshot()).draft, prompt);
  await assert.rejects(page.evaluate(buildClaudePromptInsertExpression("overwrite")), /not empty/);
  const rendered = await snapshot();
  assert.notEqual(rendered.userText, userSource);
  const initial = { ...rendered, userText: userSource };
  const hash = claudePromptHash(initial);
  assert.ok(hash);
  assertClaudeAnswer(initial, hash);
  // Reloaded pages lack data-perf-reply-text; the public Markdown container remains.
  await page.reload();
  assert.throws(() => assertClaudeAnswer(rendered, hash), /saved prompt/);
  const { targetInfos } = await (
    await browser.target().createCDPSession()
  ).send("Target.getTargets");
  const runtime = {
    chromeHost: "127.0.0.1",
    chromePort: chrome.port,
    chromeTargetId: targetInfos.find((target) => target.url === url).targetId,
    tabUrl: url,
    submittedPromptHash: hash,
    promptSubmitted: true,
  };
  const config = {
    desiredModel: "Fable 5.1",
    thinkingTime: "max",
    timeoutMs: 1,
    inputTimeoutMs: 1000,
  };
  await page.evaluate(() => {
    document
      .querySelector('[data-perf-row="assistant"]')
      .setAttribute("data-perf-row-streaming", "true");
  });
  assert.throws(() => assertClaudeAnswer({ ...initial, complete: false }, hash), /not complete/);
  await assert.rejects(
    resumeClaudeBrowser(runtime, config, () => {}),
    /timed out/,
  );
  assert.equal(await page.evaluate("window.sends"), 0);
  await page.evaluate(() => {
    document
      .querySelector('[data-perf-row="assistant"]')
      .setAttribute("data-perf-row-streaming", "false");
    // Mimic the default model appearing briefly during hydration.
    const picker = document.querySelector('[data-testid="model-selector-dropdown"]');
    picker.setAttribute("aria-label", "Model: Sonnet 5 Medium");
    setTimeout(() => picker.setAttribute("aria-label", "Model: Fable 5.1 Max"), 150);
  });
  const recovered = await resumeClaudeBrowser(runtime, config, () => {});
  assert.equal(recovered.answerMarkdown, markdown);
  assert.equal(recovered.claudeSnapshot.userText, userSource);
  assert.equal(await page.evaluate("window.sends"), 0);
  assert.equal(peer.isClosed(), false);
  assert.throws(
    () => assertClaudeAnswer({ ...initial, userText: "A different turn" }, hash),
    /saved prompt/,
  );
  assert.throws(
    () => assertClaudeAnswer({ ...initial, modelLabel: "Model: Fable 5.1 High" }, hash),
    /selection/,
  );
  await page.evaluate(() => {
    document.querySelector('[data-testid="user-message-copy"]').onclick = () =>
      navigator.clipboard.writeText("Different source");
  });
  await assert.rejects(
    resumeClaudeBrowser(runtime, config, () => {}),
    /saved prompt/,
  );
  assert.equal(await page.evaluate("window.sends"), 0);
  console.log(
    "PASS: multiline input, existing-draft refusal, reload, delayed identity, timeout recovery, Markdown, zero sends, peer preservation, stale-turn and effort refusal",
  );
} finally {
  await browser?.disconnect();
  await chrome.kill();
}
