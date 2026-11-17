import test from "node:test";
import assert from "node:assert/strict";
import { supabaseAuthHeaders } from "../worker/src/supabase-auth.mjs";

test("new Supabase secret keys are sent only as apikey, never as bearer JWTs", () => {
  const headers = supabaseAuthHeaders("sb_secret_test_value");
  assert.deepEqual(headers, { apikey: "sb_secret_test_value" });
  assert.equal("Authorization" in headers, false);
});

test("legacy service-role JWT keys remain compatible with apikey and bearer headers", () => {
  const legacy = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature";
  assert.deepEqual(supabaseAuthHeaders(legacy), {
    apikey: legacy,
    Authorization: "Bearer " + legacy,
  });
});

test("empty Supabase API keys fail closed", () => {
  assert.throws(() => supabaseAuthHeaders(" "), /SUPABASE_API_KEY_REQUIRED/);
});
