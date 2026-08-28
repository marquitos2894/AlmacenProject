-- =====================================================================
-- 0019 — `codigo_asignado` en equipo_unidad_operativa.
--
-- Es el código que recibe el equipo mientras está en esa unidad operativa
-- (número de flota, código interno del proyecto…). Pertenece a la
-- asignación, no al equipo: el mismo equipo puede llevar códigos distintos
-- según el proyecto donde esté.
--
-- Idempotente: puede re-ejecutarse en el SQL Editor de Supabase.
-- =====================================================================

alter table public.equipo_unidad_operativa
  add column if not exists codigo_asignado varchar;

-- Dos equipos no pueden llevar el mismo código a la vez en la misma unidad.
-- Se limita a las asignaciones abiertas: al cerrarse, el código queda libre
-- para reutilizarse sin ensuciar el historial.
create unique index if not exists uq_euo_codigo_asignado_vigente
  on public.equipo_unidad_operativa (unidad_operativa_id, upper(btrim(codigo_asignado)))
  where codigo_asignado is not null
    and btrim(codigo_asignado) <> ''
    and fecha_fin is null
    and activo;

create index if not exists idx_euo_codigo_asignado
  on public.equipo_unidad_operativa (upper(btrim(codigo_asignado)));

-- Se suelta y recrea: `create or replace view` no admite reordenar columnas.
drop view if exists public.vw_equipo_unidad_operativa;

create view public.vw_equipo_unidad_operativa
with (security_invoker = true) as
select
  euo.id, euo.equipo_id, euo.unidad_operativa_id,
  euo.codigo_asignado,
  euo.fecha_inicio, euo.fecha_fin, euo.estado, euo.observacion, euo.activo,
  concat_ws('/', nullif(btrim(e.modelo), ''), nullif(btrim(e.no_serie), '')) as equipo_etiqueta,
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
  (euo.fecha_fin is null) as vigente
from public.equipo_unidad_operativa euo
join public.equipos e on e.id = euo.equipo_id
join public.unidad_operativa uo on uo.id = euo.unidad_operativa_id
where euo.activo;

grant select on public.vw_equipo_unidad_operativa to authenticated;
