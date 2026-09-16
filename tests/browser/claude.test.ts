import { describe, expect, test } from "vitest";
import {
  assertClaudeAnswer,
  assertClaudeSelection,
  claudeConversationId,
  claudePromptHash,
  runClaudeBrowser,
  type ClaudeSnapshot,
} from "../../src/browser/claude.js";
import { resolveBrowserProvider, resolveRemoteBrowserModel } from "../../src/browser/provider.js";
import { resolveBrowserExecutor } from "../../src/browser/executor.js";
import { resolveRunOptionsFromConfig } from "../../src/cli/runOptions.js";
import { buildBrowserConfig } from "../../src/cli/browserConfig.js";
import { resolveBrowserFollowupReference } from "../../src/cli/followup.js";

const url = "https://claude.ai/chat/12345678-1234-1234-1234-123456789abc";
const snapshot: ClaudeSnapshot = {
  title: "Review",
  assistantCount: 1,
  sendExists: true,
  focused: false,
  visibilityState: "visible",
  url,
  modelLabel: "Model: Fable 5.1 Max 3.5× or more usage",
  ready: true,
  draft: "",
  userIndex: "0",
  userText: "Review this patch.",
  assistantIndex: "1",
  answerText: "Approved.",
  complete: true,
  notices: "Claude finished the response",
};

describe("Claude browser routing", () => {
  test("uses the browser even when API credentials are present", async () => {
    const result = resolveRunOptionsFromConfig({
      model: "claude-fable-5-1",
      engine: "browser",
      prompt: "review",
      env: { ANTHROPIC_API_KEY: "test-unused", OPENAI_API_KEY: "test-unused" },
    });
    expect(result.resolvedEngine).toBe("browser");
    expect(result.runOptions.model).toBe("claude-fable-5-1");
    expect(await resolveBrowserExecutor({ model: result.runOptions.model })).toBe(runClaudeBrowser);
    expect(resolveBrowserProvider("gpt-6-pro")).toBe("chatgpt");
  });
  test("rejects unknown Claude browser targets rather than substituting GPT or API", () => {
    for (const model of ["claude-fable-5-2", "claude-unknown", "claude-4.1-opus"]) {
      expect(() =>
        resolveRunOptionsFromConfig({ model, engine: "browser", prompt: "review", env: {} }),
      ).toThrow(/Other models require/);
    }
  });
  test("preserves explicit API routing", () => {
    expect(
      resolveRunOptionsFromConfig({
        model: "claude-fable-5-1",
        engine: "api",
        prompt: "review",
        env: {},
      }).resolvedEngine,
    ).toBe("api");
  });
  test("defaults to Fable 5.1 Max and preserves upstream 6 Pro defaults", async () => {
    expect(await buildBrowserConfig({ model: "claude-fable-5-1" })).toMatchObject({
      desiredModel: "Fable 5.1",
      thinkingTime: "max",
      modelStrategy: "select",
    });
    expect(await buildBrowserConfig({ model: "gpt-6-pro" })).toMatchObject({
      desiredModel: "Latest",
      thinkingTime: "pro",
    });
    await expect(
      buildBrowserConfig({ model: "gpt-6-pro", browserThinkingTime: "max" }),
    ).rejects.toThrow(/only for claude/);
  });
  test("rejects unsupported execution options before opening a browser", async () => {
    expect(() => resolveRemoteBrowserModel("claude-fable-5-1", undefined)).toThrow(/Unsupported/);
    await expect(
      runClaudeBrowser({ prompt: "review", config: { thinkingTime: "pro" } }),
    ).rejects.toThrow(/Max effort/);
    await expect(
      runClaudeBrowser({
        prompt: "review",
        attachments: [{ path: "secret.pdf", displayPath: "secret.pdf" }],
      }),
    ).rejects.toThrow(/text evidence inline/);
    await expect(
      resolveBrowserExecutor({ model: "claude-fable-5-1" }, { host: "example.com:1234" }),
    ).rejects.toThrow(/local Chrome/);
  });
});

describe("Claude evidence and recovery", () => {
  test("accepts only durable Claude conversation URLs", () => {
    expect(claudeConversationId(url)).toBe("12345678-1234-1234-1234-123456789abc");
    for (const value of [
      "https://claude.ai/new",
      "https://claude.ai/new?incognito=1",
      url + "?redirect=evil",
      url.replace("claude.ai", "claude.ai.evil.test"),
      url.replace("https:", "http:"),
      url.replace("claude.ai", "user@claude.ai"),
      url.replace("/chat/", "/project/"),
    ])
      expect(claudeConversationId(value)).toBeUndefined();
  });
  test("does not accept High, a similar model label, or a quota notice", () => {
    expect(() => assertClaudeSelection(snapshot)).not.toThrow();
    for (const modelLabel of [
      "Model: Fable 5.1 High",
      "Model: Fable 5.10 Max",
      "Model: Opus 5 Max",
      "Fable 5.1 Max subscription",
    ])
      expect(() => assertClaudeSelection({ ...snapshot, modelLabel })).toThrow(/selection/);
    expect(() => assertClaudeSelection({ ...snapshot, notices: "Usage limit reached" })).toThrow(
      /quota/,
    );
  });
  test("requires the same committed user turn and positive completion", () => {
    const fingerprint = claudePromptHash(snapshot)!;
    expect(() => assertClaudeAnswer(snapshot, fingerprint)).not.toThrow();
    expect(() => assertClaudeAnswer({ ...snapshot, complete: false }, fingerprint)).toThrow(
      /not complete/,
    );
    for (const changed of [
      { userText: "Different review" },
      { userIndex: "2" },
      { url: url.replace("123456789abc", "123456789abd") },
    ])
      expect(() => assertClaudeAnswer({ ...snapshot, ...changed }, fingerprint)).toThrow(
        /saved prompt/,
      );
  });
  test("follow-ups retain the Claude model, Max effort, and saved URL", async () => {
    const result = await resolveBrowserFollowupReference("claude-review", {
      readSession: async () => ({
        id: "claude-review",
        createdAt: "2026-09-15",
        status: "completed",
        mode: "browser",
        model: "claude-fable-5-1",
        options: {},
        browser: {
          runtime: { tabUrl: url },
          config: { desiredModel: "Fable 5.1", thinkingTime: "max", attachRunning: true },
        },
      }),
    });
    expect(result).toMatchObject({
      model: "claude-fable-5-1",
      resumeConversationUrl: url,
      browserConfig: { thinkingTime: "max", desiredModel: "Fable 5.1", attachRunning: true },
    });
  });
});
