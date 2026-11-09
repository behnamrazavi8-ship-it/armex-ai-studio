import { assertEquals } from "jsr:@std/assert";
import {
  hasDurableVerifiedPayment,
  paymentGrantIdempotencyKey,
  shouldCancelUnverifiedPayment,
} from "./payment-callback-policy.ts";
import {
  decideRunpodCallbackAction,
  runpodRefundIdempotencyKey,
} from "./runpod-callback-policy.ts";

/**
 * Deterministic callback integration simulation.
 * These adapters model durable DB writes and provider calls in memory; they
 * do not connect to Supabase, Zarinpal, or RunPod.
 */

type PaymentOrder = {
  id: string;
  status: "pending" | "cancelled" | "paid";
  provider_metadata: Record<string, unknown>;
};

class FakePaymentAdapter {
  order: PaymentOrder = {
    id: "order-1",
    status: "pending",
    provider_metadata: {},
  };
  readonly walletLedger = new Map<string, number>();
  verificationCalls = 0;
  failGrantAfterCommitOnce = false;

  async verify(): Promise<{ ok: boolean; ref_id: string }> {
    this.verificationCalls++;
    await Promise.resolve();
    return { ok: true, ref_id: "zarinpal-ref-123" };
  }

  async grant(key: string, credits: number): Promise<boolean> {
    if (this.walletLedger.has(key)) return true;
    this.walletLedger.set(key, credits);
    if (this.failGrantAfterCommitOnce) {
      this.failGrantAfterCommitOnce = false;
      throw new Error("simulated transport loss after durable ledger commit");
    }
    return true;
  }

  async callback(callbackStatus: string): Promise<"cancelled" | "granted" | "retry"> {
    const snapshot = { ...this.order, provider_metadata: { ...this.order.provider_metadata } };
    if (shouldCancelUnverifiedPayment(callbackStatus, snapshot.status)) {
      if (this.order.status === "pending") this.order.status = "cancelled";
      return "cancelled";
    }

    let refId: string | number | null = null;
    if (hasDurableVerifiedPayment(snapshot.status, snapshot.provider_metadata)) {
      const saved = snapshot.provider_metadata.ref_id;
      refId = typeof saved === "string" || typeof saved === "number" ? saved : null;
    } else {
      const verified = await this.verify();
      if (!verified.ok) return "retry";
      refId = verified.ref_id;
      this.order = {
        ...this.order,
        status: "paid",
        provider_metadata: { ref_id: refId },
      };
    }

    try {
      await this.grant(paymentGrantIdempotencyKey(this.order.id), 500);
      return "granted";
    } catch {
      return "retry";
    }
  }
}

type VideoJob = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  refund_status: "not_required" | "pending" | "completed";
};

class FakeRunpodAdapter {
  job: VideoJob = { id: "video-1", status: "queued", refund_status: "not_required" };
  readonly refundLedger = new Map<string, number>();
  failRefundAfterCommitOnce = false;

  async refund(key: string, credits: number): Promise<boolean> {
    if (this.refundLedger.has(key)) return true;
    this.refundLedger.set(key, credits);
    if (this.failRefundAfterCommitOnce) {
      this.failRefundAfterCommitOnce = false;
      throw new Error("simulated transport loss after durable refund commit");
    }
    return true;
  }

  async callback(providerStatus: "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT"): Promise<"duplicate" | "completed" | "refunded" | "retry"> {
    const action = decideRunpodCallbackAction(
      this.job.status,
      this.job.refund_status,
      providerStatus,
    );
    if (action === "duplicate") return "duplicate";

    if (action === "complete") {
      if (this.job.status !== "queued" && this.job.status !== "processing") return "duplicate";
      this.job.status = "completed";
      return "completed";
    }

    if (action === "claim_failure") {
      if (this.job.status !== "queued" && this.job.status !== "processing") return "duplicate";
      this.job.status = providerStatus === "CANCELLED" ? "cancelled" : "failed";
      this.job.refund_status = "pending";
    }

    try {
      await this.refund(runpodRefundIdempotencyKey(this.job.id), 80);
      this.job.refund_status = "completed";
      return "refunded";
    } catch {
      return "retry";
    }
  }
}

Deno.test("two concurrent Zarinpal callbacks produce one wallet ledger grant", async () => {
  const fake = new FakePaymentAdapter();
  const outcomes = await Promise.all([fake.callback("OK"), fake.callback("OK")]);

  assertEquals(fake.order.status, "paid");
  assertEquals(fake.walletLedger.size, 1);
  assertEquals(fake.walletLedger.get("payment_order:order-1"), 500);
  assertEquals(outcomes.every((item) => item === "granted"), true);
});

Deno.test("verified payment retries wallet grant after ambiguous commit without re-verifying", async () => {
  const fake = new FakePaymentAdapter();
  fake.failGrantAfterCommitOnce = true;

  assertEquals(await fake.callback("OK"), "retry");
  assertEquals(fake.order.status, "paid");
  assertEquals(fake.walletLedger.size, 1);

  assertEquals(await fake.callback("NOK"), "granted");
  assertEquals(fake.verificationCalls, 1);
  assertEquals(fake.walletLedger.size, 1);
});

Deno.test("late NOK callback cannot cancel a durably paid order", async () => {
  const fake = new FakePaymentAdapter();
  assertEquals(await fake.callback("OK"), "granted");
  assertEquals(await fake.callback("NOK"), "granted");
  assertEquals(fake.order.status, "paid");
  assertEquals(fake.walletLedger.size, 1);
});

Deno.test("concurrent RunPod failure callbacks share one refund identity", async () => {
  const fake = new FakeRunpodAdapter();
  const outcomes = await Promise.all([fake.callback("FAILED"), fake.callback("FAILED")]);

  assertEquals(fake.job.status, "failed");
  assertEquals(fake.job.refund_status, "completed");
  assertEquals(fake.refundLedger.size, 1);
  assertEquals(fake.refundLedger.get("ai_refund:video-1:video-1:video_refund"), 80);
  assertEquals(outcomes.includes("refunded"), true);
});

Deno.test("RunPod refund retry after ambiguous commit does not create a second refund", async () => {
  const fake = new FakeRunpodAdapter();
  fake.failRefundAfterCommitOnce = true;

  assertEquals(await fake.callback("FAILED"), "retry");
  assertEquals(fake.job.status, "failed");
  assertEquals(fake.job.refund_status, "pending");

  assertEquals(await fake.callback("FAILED"), "refunded");
  assertEquals(fake.refundLedger.size, 1);
  assertEquals(fake.job.refund_status, "completed");
});

Deno.test("RunPod success/failure race preserves one terminal winner", async () => {
  const fake = new FakeRunpodAdapter();
  await Promise.all([fake.callback("COMPLETED"), fake.callback("FAILED")]);

  assertEquals(["completed", "failed"].includes(fake.job.status), true);
  assertEquals(fake.refundLedger.size, fake.job.status === "failed" ? 1 : 0);
});
