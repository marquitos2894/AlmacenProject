-- =====================================================================
-- 0004 — Fija search_path en las funciones del proyecto.
--
-- El linter de seguridad de Supabase marca function_search_path_mutable:
-- sin un search_path fijo, una función con el mismo nombre creada en otro
-- esquema que aparezca antes en el search_path del llamador podría
-- "secuestrar" la resolución de objetos no calificados dentro de la función.
-- Todas las funciones del proyecto ya califican sus tablas con `public.`,
-- así que el riesgo real era bajo, pero fijar el search_path es gratis y
-- cierra el aviso del linter.
--
-- Idempotente: puede re-ejecutarse en el SQL Editor de Supabase.
-- =====================================================================

alter function public.fn_productos_codigo_barras() set search_path = public, pg_temp;
alter function public.fn_movimientos_folio() set search_path = public, pg_temp;
alter function public.fn_pa_sync_activo_fijo() set search_path = public, pg_temp;
alter function public.fn_productos_propagar_activo_fijo() set search_path = public, pg_temp;
alter function public.registrar_movimiento(bigint, date, varchar, boolean, varchar, text, bigint, jsonb)
  set search_path = public, pg_temp;
