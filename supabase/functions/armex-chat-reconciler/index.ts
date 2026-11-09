import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { deriveAcceptedChatPayload } from "./recovery-payload.ts";

type Json = Record<string, unknown>;
type ReconciliationRow = {
  user_id: string;
  request_id: string;
  provider_outcome: string;
  debit_outcome: string;
  provider_http_status: number | null;
  provider_response_payload: Json | null;
  reconciliation_lease_token: string;
  reconciliation_attempts: number;
};

const json = (body: Json, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const env = (name: string): string => {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error("Missing server configuration: " + name);
  return value;
};

const safeNumber = (value: unknown, fallback = 0): number => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0
    ? number
    : fallback;
};

const isObject = (value: unknown): value is Json =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const constantTimeEqual = (left: string, right: string): boolean => {
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
};

const refundCredits = async (
  db: SupabaseClient,
  row: ReconciliationRow,
  amount: number,
  attemptId: string,
  reason: string,
): Promise<boolean> => {
  if (!Number.isSafeInteger(amount) || amount <= 0 || !attemptId) return false;
  const idempotencyKey = "ai_refund:" + row.request_id + ":" + attemptId + ":" + reason;
  const { data, error } = await db.rpc("armex_grant_credits", {
    p_user_id: row.user_id,
    p_amount: amount,
    p_type: "refund",
    p_idempotency_key: idempotencyKey,
    p_description: "بازگشت اعتبار درخواست ناموفق",
    p_metadata: {
      request_id: row.request_id,
      attempt_id: attemptId,
      reason,
      source: "chat_reconciliation_worker",
    },
  });
  if (!error && data === true) return true;

  const { data: existing, error: lookupError } = await db
    .from("armex_credit_transactions")
    .select("id")
    .eq("user_id", row.user_id)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  return !lookupError && Boolean(existing);
};

const releaseLease = async (
  db: SupabaseClient,
  row: ReconciliationRow,
  diagnostic: string,
  manualReview = false,
): Promise<boolean> => {
  const requireManualReview = manualReview || row.reconciliation_attempts >= 5;
  const code = (requireManualReview ? "manual_review:" : "retryable:") + diagnostic;
  const { data, error } = await db.rpc("armex_release_chat_reconciliation", {
    p_user_id: row.user_id,
    p_request_id: row.request_id,
    p_lease_token: row.reconciliation_lease_token,
    p_diagnostic_code: code,
  });
  return !error && data === true;
};

const markFailed = async (
  db: SupabaseClient,
  row: ReconciliationRow,
  failureCode: string,
): Promise<boolean> => {
  const { data, error } = await db.rpc("armex_fail_chat_request", {
    p_user_id: row.user_id,
    p_request_id: row.request_id,
    p_failure_code: failureCode.slice(0, 80),
  });
  if (error || data !== true) return false;

  // The status is already terminal. Clearing the old lease is best-effort.
  await db.from("armex_chat_requests").update({
    reconciliation_lease_token: null,
    reconciliation_lease_expires_at: null,
    reconciled_at: new Date().toISOString(),
  }).eq("user_id", row.user_id).eq("request_id", row.request_id).eq("status", "failed");
  return true;
};

const markManualReview = async (
  db: SupabaseClient,
  row: ReconciliationRow,
  reason: string,
): Promise<void> => {
  await releaseLease(db, row, reason, true);
};

const processAccepted = async (
  db: SupabaseClient,
  row: ReconciliationRow,
  recovery: Json,
): Promise<"completed" | "retry" | "manual_review"> => {
  if (row.debit_outcome !== "debited" || !isObject(row.provider_response_payload)) {
    await markManualReview(db, row, "accepted_response_missing_confirmed_debit_or_snapshot");
    return "manual_review";
  }

  const payload = deriveAcceptedChatPayload(
    row.provider_response_payload,
    {
      recovery_model: recovery.recovery_model,
      recovery_estimated_input_tokens: recovery.recovery_estimated_input_tokens,
      recovery_prompt_price: recovery.recovery_prompt_price,
      recovery_completion_price: recovery.recovery_completion_price,
    },
  );
  if (!payload || !Number.isSafeInteger(recovery.recovery_credits) ||
      Number(recovery.recovery_credits) < 1) {
    await markManualReview(db, row, "accepted_response_payload_is_not_recoverable");
    return "manual_review";
  }

  const { error } = await db.rpc("armex_persist_chat_response_atomic", {
    p_user_id: row.user_id,
    p_request_id: row.request_id,
    p_lease_token: row.reconciliation_lease_token,
    p_answer: payload.answer,
    p_model: payload.model,
    p_input_tokens: payload.inputTokens,
    p_output_tokens: payload.outputTokens,
    p_total_tokens: payload.totalTokens,
    p_actual_cost_usd: payload.actualCostUsd,
    p_finish_reason: payload.finishReason,
  });

  if (error) {
    await releaseLease(db, row, "atomic_persistence_failed:" + (error.code || "unknown"));
    return row.reconciliation_attempts >= 5 ? "manual_review" : "retry";
  }
  return "completed";
};

const processRefundableFailure = async (
  db: SupabaseClient,
  row: ReconciliationRow,
  recovery: Json,
): Promise<"failed" | "retry" | "manual_review"> => {
  if (!["rejected", "not_started"].includes(row.provider_outcome)) {
    await markManualReview(db, row, "unsupported_provider_outcome");
    return "manual_review";
  }

  if (["not_attempted", "not_debited"].includes(row.debit_outcome)) {
    const failureCode = row.provider_outcome === "rejected"
      ? "provider_rejected_" + String(row.provider_http_status ?? "unknown")
      : "provider_not_started";
    const failed = await markFailed(db, row, failureCode);
    if (!failed) {
      await releaseLease(db, row, "failed_state_write_unconfirmed");
      return row.reconciliation_attempts >= 5 ? "manual_review" : "retry";
    }
    return "failed";
  }

  if (row.debit_outcome !== "debited") {
    await markManualReview(db, row, "refund_not_safe_debit_outcome_unknown");
    return "manual_review";
  }

  const amount = Number(recovery.recovery_credits);
  const attemptId = typeof recovery.recovery_attempt_id === "string"
    ? recovery.recovery_attempt_id
    : "";
  const reason = row.provider_outcome === "rejected"
    ? "provider_error"
    : "pre_provider_error";

  if (!Number.isSafeInteger(amount) || amount <= 0 || !attemptId) {
    await markManualReview(db, row, "confirmed_debit_missing_refund_metadata");
    return "manual_review";
  }

  const refunded = await refundCredits(db, row, amount, attemptId, reason);
  if (!refunded) {
    await releaseLease(db, row, "refund_confirmation_pending");
    return row.reconciliation_attempts >= 5 ? "manual_review" : "retry";
  }

  const failureCode = row.provider_outcome === "rejected"
    ? "provider_rejected_" + String(row.provider_http_status ?? "unknown")
    : "provider_not_started_refunded";
  const failed = await markFailed(db, row, failureCode);
  if (!failed) {
    await releaseLease(db, row, "refund_confirmed_but_failure_state_pending");
    return row.reconciliation_attempts >= 5 ? "manual_review" : "retry";
  }
  return "failed";
};

const handle = async (request: Request): Promise<Response> => {
  if (request.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  let supabaseUrl: string;
  let serviceRoleKey: string;
  try {
    supabaseUrl = env("SUPABASE_URL");
    serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  } catch {
    return json({ success: false, error: "Reconciliation worker is not configured" }, 503);
  }

  if (serviceRoleKey.length < 32) {
    return json({ success: false, error: "Service role key is invalid" }, 503);
  }
  // Keep platform JWT verification enabled; only the service-role JWT may
  // invoke this internal maintenance endpoint.
  const authorization = request.headers.get("Authorization") ?? "";
  const suppliedSecret = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!constantTimeEqual(suppliedSecret, serviceRoleKey)) {
    return json({ success: false, error: "Unauthorized" }, 401);
  }

  let limit = 10;
  if (request.headers.get("Content-Type")?.includes("application/json")) {
    const body = await request.json().catch(() => null);
    if (isObject(body) && body.limit !== undefined) {
      const requested = Number(body.limit);
      if (!Number.isInteger(requested) || requested < 1 || requested > 20) {
        return json({ success: false, error: "limit must be an integer between 1 and 20" }, 400);
      }
      limit = requested;
    }
  }

  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: claimedData, error: claimError } = await db.rpc(
    "armex_claim_chat_reconciliation",
    { p_limit: limit, p_lease_seconds: 120 },
  );
  if (claimError) {
    console.error("Chat reconciliation claim failed", { code: claimError.code });
    return json({ success: false, error: "Could not claim reconciliation work" }, 500);
  }

  const claimed = Array.isArray(claimedData) ? claimedData as ReconciliationRow[] : [];
  const summary = { claimed: claimed.length, completed: 0, failed: 0, retry_pending: 0, manual_review: 0 };

  for (const row of claimed) {
    try {
      const { data: recovery, error: recoveryError } = await db
        .from("armex_chat_requests")
        .select([
          "provider_outcome", "debit_outcome", "provider_response_payload",
          "recovery_message", "recovery_model", "recovery_conversation_id",
          "recovery_credits", "recovery_attempt_id", "recovery_prompt_price",
          "recovery_completion_price", "recovery_estimated_input_tokens",
          "reconciliation_lease_token",
        ].join(","))
        .eq("user_id", row.user_id)
        .eq("request_id", row.request_id)
        .eq("status", "processing")
        .eq("reconciliation_lease_token", row.reconciliation_lease_token)
        .maybeSingle();

      if (recoveryError || !recovery) {
        await releaseLease(db, row, "recovery_metadata_read_failed");
        if (row.reconciliation_attempts >= 5) summary.manual_review++;
        else summary.retry_pending++;
        continue;
      }

      const result = row.provider_outcome === "accepted"
        ? await processAccepted(db, row, recovery as Json)
        : await processRefundableFailure(db, row, recovery as Json);

      if (result === "completed") summary.completed++;
      else if (result === "failed") summary.failed++;
      else if (result === "manual_review") summary.manual_review++;
      else summary.retry_pending++;
    } catch (error) {
      console.error("Chat reconciliation item failed", {
        requestId: row.request_id,
        error: error instanceof Error ? error.message : "unknown",
      });
      await releaseLease(db, row, "worker_exception");
      summary.retry_pending++;
    }
  }

  return json({ success: true, summary });
};

Deno.serve(handle);
