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

// PostgREST solo devuelve 1000 filas por consulta si no se pide un rango
// explícito, y las excedentes se pierden en silencio (sin error). `factory`
// debe devolver una consulta NUEVA cada vez (no se puede reusar un builder ya
// consumido). Úsalo cuando de verdad haga falta traer todas las filas para
// agregarlas en el cliente (sumas, conteos por grupo); si solo hace falta
// "cuántas filas cumplen X", un `count: 'exact', head: true` es más barato.
export async function fetchAll(factory, pageSize = 1000) {
  let filas = [];
  let desde = 0;
  for (;;) {
    const { data, error } = await factory().range(desde, desde + pageSize - 1);
    if (error) throw error;
    filas = filas.concat(data || []);
    if (!data || data.length < pageSize) break;
    desde += pageSize;
  }
  return filas;
}
