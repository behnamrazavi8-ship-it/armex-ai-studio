// Public browser configuration only. Never put a Supabase service_role key here.
window.LOKAL_CONFIG = Object.freeze({
  // Production owns authentication, wallet, chat, image generation, and image editing.
  supabaseUrl: "https://znendbwkmcldttugvwnr.supabase.co",
  supabaseAnonKey: "sb_publishable_vLAGY6MfqEWJVV_WQbD-Iw_gqjHEYVm",
  // The separate LOKAL-AI-STAGING project handles Prompt Intelligence only.
  promptIntelligenceUrl: "https://pismnyrbbdrreugpxjcj.supabase.co",
  promptIntelligenceAnonKey: "sb_publishable_rZjBvvNW480IaFfGTF-ncA_QS6jUmSH"
});
