export function supabaseAuthHeaders(apiKey) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) throw new Error("SUPABASE_API_KEY_REQUIRED");
  if (key.startsWith("sb_secret_")) return { apikey: key };
  return { apikey: key, Authorization: "Bearer " + key };
}
