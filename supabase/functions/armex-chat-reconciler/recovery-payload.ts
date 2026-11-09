export type Json = Record<string, unknown>;

export type RecoveryMetadata = {
  recovery_model: unknown;
  recovery_estimated_input_tokens: unknown;
  recovery_prompt_price: unknown;
  recovery_completion_price: unknown;
};

export type AcceptedChatPayload = {
  answer: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  actualCostUsd: number | null;
  finishReason: string | null;
};

const isObject = (value: unknown): value is Json =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const safeNumber = (value: unknown, fallback = 0): number => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0
    ? number
    : fallback;
};

/**
 * Rebuilds the exact normalized usage fields used by the live chat handler.
 * This function is pure: it never calls the provider or accesses the database.
 */
export const deriveAcceptedChatPayload = (
  snapshot: Json,
  recovery: RecoveryMetadata,
): AcceptedChatPayload | null => {
  const choices = Array.isArray(snapshot.choices) ? snapshot.choices : [];
  const firstChoice = isObject(choices[0]) ? choices[0] : {};
  const assistant = isObject(firstChoice.message) ? firstChoice.message : {};
  const answer = typeof assistant.content === "string" ? assistant.content : "";
  const recoveryModel = typeof recovery.recovery_model === "string"
    ? recovery.recovery_model
    : "";
  const model = typeof snapshot.model === "string" && snapshot.model
    ? snapshot.model
    : recoveryModel;
  const estimatedInputTokens = Number(recovery.recovery_estimated_input_tokens);

  if (!answer.trim() || !model || !Number.isSafeInteger(estimatedInputTokens) ||
      estimatedInputTokens < 1) {
    return null;
  }

  const usage = isObject(snapshot.usage) ? snapshot.usage : {};
  const inputTokens = safeNumber(usage.prompt_tokens, estimatedInputTokens);
  const outputTokens = safeNumber(usage.completion_tokens, Math.ceil(answer.length / 4));
  const totalTokens = safeNumber(usage.total_tokens, inputTokens + outputTokens);
  const reportedCost = safeNumber(usage.cost, -1);
  const promptPrice = safeNumber(recovery.recovery_prompt_price, -1);
  const completionPrice = safeNumber(recovery.recovery_completion_price, -1);
  const calculatedCost = promptPrice >= 0 && completionPrice >= 0
    ? inputTokens * promptPrice + outputTokens * completionPrice
    : -1;
  const actualCostUsd = reportedCost >= 0
    ? reportedCost
    : calculatedCost >= 0
    ? calculatedCost
    : null;

  return {
    answer,
    model,
    inputTokens,
    outputTokens,
    totalTokens,
    actualCostUsd,
    finishReason: typeof firstChoice.finish_reason === "string"
      ? firstChoice.finish_reason
      : null,
  };
};
