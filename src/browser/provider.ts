export const CLAUDE_BROWSER_MODEL = "claude-fable-5-1";

export function resolveBrowserProvider(
  model: unknown,
): "chatgpt" | "gemini" | "claude" | undefined {
  if (typeof model !== "string") return undefined;
  const normalized = model.trim().toLowerCase();
  if (normalized === CLAUDE_BROWSER_MODEL) return "claude";
  if (normalized.startsWith("gemini")) return "gemini";
  if (normalized.startsWith("gpt-")) return "chatgpt";
  return undefined;
}

export function resolveRemoteBrowserModel(
  model: unknown,
  desiredModel: unknown,
): string | undefined {
  if (model !== undefined) {
    const provider = resolveBrowserProvider(model);
    if (typeof model === "string" && provider && provider !== "claude") return model;
    throw new Error(`Unsupported browser model: ${String(model)}. Use a GPT or Gemini model.`);
  }
  const provider = resolveBrowserProvider(desiredModel);
  if (typeof desiredModel === "string" && provider && provider !== "claude") return desiredModel;
  // Older ChatGPT clients send only a picker label, or omit the selection entirely.
  if (
    desiredModel == null ||
    (typeof desiredModel === "string" &&
      /^(?:|latest|auto|pro|thinking|instant)(?:\s.*)?$/i.test(desiredModel.trim()))
  )
    return undefined;
  throw new Error(`Unsupported browser model: ${String(desiredModel)}. Use a GPT or Gemini model.`);
}
