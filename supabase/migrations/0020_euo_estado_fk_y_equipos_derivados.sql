-- =====================================================================
-- 0020 — El estado de la asignación pasa a ser FK al catálogo, y
--        equipos.estado_actual / unidad_actual se derivan de la asignación.
--
-- Nota sobre la regla "un equipo en una sola unidad operativa a la vez":
-- ya la impone el índice `uq_euo_asignacion_abierta` creado en la 0017
-- (máximo una asignación sin fecha_fin por equipo). No se repite aquí.
--
-- Idempotente: puede re-ejecutarse en el SQL Editor de Supabase.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Preservar los estados que hoy están como texto libre.
--    "Operativo" no existe en el catálogo; sin este paso, la conversión
--    a FK lo perdería.
-- ---------------------------------------------------------------------

insert into public.estados (nombre, descripcion)
select distinct btrim(a.estado), 'Estado de equipo (migrado desde texto libre)'
  from public.equipo_unidad_operativa a
 where a.estado is not null and btrim(a.estado) <> ''
   and not exists (
     select 1 from public.estados e
      where upper(btrim(e.nombre)) = upper(btrim(a.estado))
   );

-- ---------------------------------------------------------------------
-- 2. estado (texto) -> estado_id (FK)
--    Se usa `estado_id` y no `id_estado` para no mezclar dos convenciones:
--    producto_almacen, producto_unidad y movimiento_detalle ya referencian
--    el catálogo con ese nombre.
-- ---------------------------------------------------------------------

alter table public.equipo_unidad_operativa
  add column if not exists estado_id bigint references public.estados(id);

update public.equipo_unidad_operativa a
   set estado_id = e.id
  from public.estados e
 where a.estado_id is null
   and a.estado is not null and btrim(a.estado) <> ''
   and upper(btrim(e.nombre)) = upper(btrim(a.estado));

drop view if exists public.vw_equipo_unidad_operativa;
alter table public.equipo_unidad_operativa drop column if exists estado;

create index if not exists idx_euo_estado on public.equipo_unidad_operativa (estado_id);

-- ---------------------------------------------------------------------
-- 3. equipos.estado_actual y unidad_actual se derivan de la asignación
--    más reciente: se prefiere la vigente (sin fecha de fin); si no hay,
--    la más reciente por fecha de inicio.
-- ---------------------------------------------------------------------

create or replace function public.fn_equipos_sync_actual()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_equipo bigint;
begin
  v_equipo := coalesce(new.equipo_id, old.equipo_id);
  if v_equipo is null then
    return null;
  end if;

  update public.equipos e
     set unidad_actual = (
           select uo.nombre
             from public.equipo_unidad_operativa a
             join public.unidad_operativa uo on uo.id = a.unidad_operativa_id
            where a.equipo_id = v_equipo and a.activo
            order by (a.fecha_fin is null) desc, a.fecha_inicio desc, a.id desc
            limit 1
         ),
         estado_actual = (
           select es.nombre
             from public.equipo_unidad_operativa a
             left join public.estados es on es.id = a.estado_id
            where a.equipo_id = v_equipo and a.activo
            order by (a.fecha_fin is null) desc, a.fecha_inicio desc, a.id desc
            limit 1
         )
   where e.id = v_equipo;

  return null;
end $$;

drop trigger if exists trg_euo_sync_equipo on public.equipo_unidad_operativa;
create trigger trg_euo_sync_equipo
  after insert or update or delete on public.equipo_unidad_operativa
  for each row execute function public.fn_equipos_sync_actual();

-- Backfill SOLO de los equipos que ya tienen asignación. Los que no la
-- tienen conservan su texto anterior: borrarlo sería perder datos que
-- todavía no se han trasladado a una asignación.
update public.equipos e
   set unidad_actual = sub.unidad,
       estado_actual = sub.estado
  from (
    select distinct on (a.equipo_id)
           a.equipo_id, uo.nombre as unidad, es.nombre as estado
      from public.equipo_unidad_operativa a
      join public.unidad_operativa uo on uo.id = a.unidad_operativa_id
      left join public.estados es on es.id = a.estado_id
     where a.activo
     order by a.equipo_id, (a.fecha_fin is null) desc, a.fecha_inicio desc, a.id desc
  ) sub
 where e.id = sub.equipo_id;

-- ---------------------------------------------------------------------
-- 4. Vista con el estado resuelto
-- ---------------------------------------------------------------------

create view public.vw_equipo_unidad_operativa
with (security_invoker = true) as
select
  euo.id, euo.equipo_id, euo.unidad_operativa_id,
  euo.codigo_asignado,
  euo.fecha_inicio, euo.fecha_fin,
  euo.estado_id, es.nombre as estado_nombre,
  euo.observacion, euo.activo,
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
left join public.estados es on es.id = euo.estado_id
where euo.activo;

grant select on public.vw_equipo_unidad_operativa to authenticated;
