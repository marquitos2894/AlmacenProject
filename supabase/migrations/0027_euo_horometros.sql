-- =====================================================================
-- 0027 — Horómetro inicial y final en la asignación de un equipo.
--
-- `equipo_unidad_operativa` es el historial de asignaciones de un equipo a
-- unidades operativas. Se añaden dos lecturas del horómetro de la máquina:
-- la de entrada (al asignarse) y la de salida (al cerrarse la asignación).
-- Ambas son opcionales; si se informan las dos, la final no puede ser menor
-- que la inicial, y no se admiten valores negativos.
--
-- La vista `vw_equipo_unidad_operativa` expone las dos columnas para el
-- historial de Equipos.
-- Idempotente.
-- =====================================================================

alter table public.equipo_unidad_operativa
  add column if not exists horometro_inicial numeric,
  add column if not exists horometro_final   numeric;

alter table public.equipo_unidad_operativa
  drop constraint if exists ck_euo_horometros;

alter table public.equipo_unidad_operativa
  add constraint ck_euo_horometros check (
    coalesce(horometro_inicial, 0) >= 0
    and coalesce(horometro_final, 0) >= 0
    and (
      horometro_final is null
      or horometro_inicial is null
      or horometro_final >= horometro_inicial
    )
  );

-- Recreada desde su definición en vivo + las dos columnas al final
-- (`create or replace view` solo admite añadir columnas nuevas al final).
create or replace view public.vw_equipo_unidad_operativa
with (security_invoker = true) as
select euo.id,
       euo.equipo_id,
       euo.unidad_operativa_id,
       euo.codigo_asignado,
       euo.fecha_inicio,
       euo.fecha_fin,
       euo.estado_id,
       es.nombre as estado_nombre,
       euo.observacion,
       euo.activo,
       concat_ws('/'::text, nullif(btrim(e.modelo::text), ''::text), nullif(btrim(e.no_serie::text), ''::text)) as equipo_etiqueta,
       e.modelo   as equipo_modelo,
       e.marca    as equipo_marca,
       e.no_serie as equipo_no_serie,
       e.codigo   as equipo_codigo,
       e.nombre   as equipo_nombre,
       uo.nombre    as unidad_nombre,
       uo.codigo    as unidad_codigo,
       uo.proyecto  as unidad_proyecto,
       uo.ubicacion as unidad_ubicacion,
       uo.zona      as unidad_zona,
       (euo.fecha_fin is null) as vigente,
       euo.horometro_inicial,
       euo.horometro_final
  from public.equipo_unidad_operativa euo
  join public.equipos e on e.id = euo.equipo_id
  join public.unidad_operativa uo on uo.id = euo.unidad_operativa_id
  left join public.estados es on es.id = euo.estado_id
 where euo.activo;

grant select on public.vw_equipo_unidad_operativa to authenticated;
