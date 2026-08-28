-- =====================================================================
-- 0021 — Historial de movimientos de un producto.
--
-- Un producto aparece en un movimiento por dos vías, y ambas cuentan:
--   * como renglón del carrito  -> movimiento_detalle.producto_id
--   * como el activo del ticket -> movimientos.id_producto_unidad
--
-- La columna `origen` distingue una de otra. Solo los renglones mueven
-- stock; los referenciados dicen "esta máquina estuvo involucrada".
--
-- Idempotente: puede re-ejecutarse en el SQL Editor de Supabase.
-- =====================================================================

create or replace view public.vw_producto_movimientos
with (security_invoker = true) as
select
  md.producto_id,
  m.id            as movimiento_id,
  m.folio,
  m.fecha,
  m.tipo_movimiento,
  m.es_stock_inicial,
  m.motivo,
  m.observaciones,
  m.created_at,
  a.nombre        as almacen_nombre,
  'Renglón'       as origen,
  md.cantidad,
  es.nombre       as estado_nombre,
  md.ubicacion,
  trim(coalesce(u.nombre, '') || ' ' || coalesce(u.apellido, '')) as usuario_nombre,
  uo.nombre       as unidad_operativa_nombre,
  concat_ws('/', nullif(btrim(eq.modelo), ''), nullif(btrim(eq.no_serie), '')) as equipo_etiqueta
from public.movimiento_detalle md
join public.movimientos m on m.id = md.movimiento_id
join public.almacenes a on a.id = m.almacen_id
left join public.estados es on es.id = md.estado_id
left join public.usuarios u on u.id = m.usuario_id
left join public.unidad_operativa uo on uo.id = m.id_unidad_operativa
left join public.equipos eq on eq.id = m.id_equipo

union all

select
  pu.producto_id,
  m.id, m.folio, m.fecha, m.tipo_movimiento, m.es_stock_inicial,
  m.motivo, m.observaciones, m.created_at,
  a.nombre,
  'Referenciado'  as origen,
  null::numeric   as cantidad,
  null::varchar   as estado_nombre,
  null::varchar   as ubicacion,
  trim(coalesce(u.nombre, '') || ' ' || coalesce(u.apellido, '')),
  uo.nombre,
  concat_ws('/', nullif(btrim(eq.modelo), ''), nullif(btrim(eq.no_serie), ''))
from public.movimientos m
join public.producto_unidad pu on pu.id = m.id_producto_unidad
join public.almacenes a on a.id = m.almacen_id
left join public.usuarios u on u.id = m.usuario_id
left join public.unidad_operativa uo on uo.id = m.id_unidad_operativa
left join public.equipos eq on eq.id = m.id_equipo
-- Si el mismo producto ya salió como renglón de ese ticket, no se repite.
where not exists (
  select 1 from public.movimiento_detalle md2
   where md2.movimiento_id = m.id and md2.producto_id = pu.producto_id
);

grant select on public.vw_producto_movimientos to authenticated;
