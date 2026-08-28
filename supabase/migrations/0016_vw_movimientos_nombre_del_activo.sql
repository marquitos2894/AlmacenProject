-- =====================================================================
-- 0016 — El ticket necesita saber de QUÉ producto es la unidad referenciada.
--
-- `unidad_descripcion` sola ("HLX5/P50406") no dice que sea una Perforadora,
-- así que se añade el nombre del producto y algunos datos del equipo para
-- poder imprimirlos en el reporte.
--
-- Idempotente: puede re-ejecutarse en el SQL Editor de Supabase.
-- =====================================================================

drop view if exists public.vw_movimientos;

create view public.vw_movimientos
with (security_invoker = true) as
select
  m.id, m.folio, m.fecha, m.tipo_movimiento, m.es_stock_inicial, m.motivo,
  m.observaciones, m.almacen_id, a.nombre as almacen_nombre, m.usuario_id,
  trim(coalesce(u.nombre, '') || ' ' || coalesce(u.apellido, '')) as usuario_nombre,
  m.created_at,
  m.id_producto_unidad,
  m.id_equipo,
  pu.descripcion         as unidad_descripcion,
  pup.nombre             as unidad_producto_nombre,
  pu.no_serie            as unidad_no_serie,
  pu.codigo_interno      as unidad_codigo_interno,
  concat_ws('/', nullif(btrim(eq.modelo), ''), nullif(btrim(eq.no_serie), '')) as equipo_etiqueta,
  eq.marca               as equipo_marca,
  eq.descripcion         as equipo_descripcion,
  d.total_items, d.total_cantidad,
  d.productos_resumen, d.busq_no_parte, d.busq_nombre, d.busq_ubicacion, d.estado_ids
from public.movimientos m
join public.almacenes a on a.id = m.almacen_id
left join public.usuarios u on u.id = m.usuario_id
left join public.producto_unidad pu on pu.id = m.id_producto_unidad
left join public.productos pup on pup.id = pu.producto_id
left join public.equipos eq on eq.id = m.id_equipo
left join lateral (
  select
    count(*)                                             as total_items,
    coalesce(sum(md.cantidad), 0)                        as total_cantidad,
    string_agg(distinct p.nombre, ', ')                  as productos_resumen,
    string_agg(distinct coalesce(p.no_parte, ''), ' ')   as busq_no_parte,
    string_agg(distinct p.nombre, ' ')                   as busq_nombre,
    string_agg(distinct coalesce(md.ubicacion, ''), ' ') as busq_ubicacion,
    array_remove(array_agg(distinct md.estado_id), null) as estado_ids
  from public.movimiento_detalle md
  join public.productos p on p.id = md.producto_id
  where md.movimiento_id = m.id
) d on true;

grant select on public.vw_movimientos to authenticated;
