-- =====================================================================
-- 0037 — Tipo de establecimiento.
--
-- "Unidades operativas" pasa a llamarse "Establecimientos" en la interfaz
-- (la tabla y las columnas conservan el nombre `unidad_operativa`). Cada
-- establecimiento se clasifica en:
--   'unidad_operativa'          — proyecto minero (valor por defecto; es lo
--                                 que son todos los registros actuales)
--   'establecimiento_transicion'
--
-- Idempotente.
-- =====================================================================

alter table public.unidad_operativa
  add column if not exists tipo_de_establecimiento text not null default 'unidad_operativa';

alter table public.unidad_operativa
  drop constraint if exists ck_unidad_operativa_tipo;
alter table public.unidad_operativa
  add constraint ck_unidad_operativa_tipo
  check (tipo_de_establecimiento in ('unidad_operativa', 'establecimiento_transicion'));

-- La vista del selector expone el tipo (se añade al final).
create or replace view public.vw_unidad_operativa_lista
with (security_invoker = true) as
select uo.id,
       uo.codigo,
       uo.nombre,
       uo.proyecto,
       uo.ubicacion,
       uo.zona,
       uo.activo,
       concat_ws(' · '::text, nullif(btrim(uo.codigo::text), ''::text), nullif(btrim(uo.nombre::text), ''::text)) as etiqueta,
       coalesce(a.total, 0) as equipos_asignados,
       uo.tipo_de_establecimiento
  from public.unidad_operativa uo
  left join lateral (
    select count(*)::integer as total
      from public.equipo_unidad_operativa e
     where e.unidad_operativa_id = uo.id and e.activo and e.fecha_fin is null
  ) a on true
 where uo.activo;

grant select on public.vw_unidad_operativa_lista to authenticated;
