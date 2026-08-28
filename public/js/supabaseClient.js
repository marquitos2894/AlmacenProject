// Cliente Supabase compartido. Requiere que public/vendor/supabase.js (UMD)
// y config.js estén cargados antes que este módulo.
const cfg = window.CONFIG || {};

if (!cfg.url || cfg.url.includes("TU-PROYECTO") || !cfg.anonKey || cfg.anonKey.includes("TU_")) {
  console.warn(
    "[config] Falta configurar public/js/config.js con tu SUPABASE_URL y SUPABASE_ANON_KEY."
  );
}

export const supabase = window.supabase.createClient(cfg.url, cfg.anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

export const isConfigured = () =>
  !!cfg.url && !cfg.url.includes("TU-PROYECTO") && !!cfg.anonKey && !cfg.anonKey.includes("TU_");
