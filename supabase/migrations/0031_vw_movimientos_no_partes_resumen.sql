-- =====================================================================
-- 0031 — Columna "No. de parte" en la lista de Movimientos.
--
-- `vw_movimientos` ya agregaba `busq_no_parte` (concatenación con espacios,
-- pensada para el filtro `ilike`, con huecos vacíos). Se añade
-- `no_partes_resumen`: los números de parte distintos del ticket, separados
-- por coma y sin nulos — para mostrarlos como columna, igual que
-- `productos_resumen`.
--
-- `create or replace view` obliga a añadir la columna nueva al final.
-- Recreada desde su definición en vivo (tiene columnas de proveedor y unidad
-- operativa fuera de las migraciones del repo).
-- Idempotente.
-- =====================================================================

create or replace view public.vw_movimientos
with (security_invoker = true) as
select
  m.id, m.folio, m.fecha, m.tipo_movimiento, m.es_stock_inicial, m.motivo,
  m.observaciones, m.almacen_id, a.nombre as almacen_nombre, m.usuario_id,
  trim(both from (coalesce(u.nombre, ''::varchar)::text || ' '::text) || coalesce(u.apellido, ''::varchar)::text) as usuario_nombre,
  m.created_at,
  m.id_producto_unidad, m.id_equipo, m.id_unidad_operativa, m.id_proveedor,
  pu.descripcion    as unidad_descripcion,
  pup.nombre        as unidad_producto_nombre,
  pu.no_serie       as unidad_no_serie,
  pu.codigo_interno as unidad_codigo_interno,
  concat_ws('/'::text, nullif(btrim(eq.modelo::text), ''::text), nullif(btrim(eq.no_serie::text), ''::text)) as equipo_etiqueta,
  eq.marca          as equipo_marca,
  eq.descripcion    as equipo_descripcion,
  uo.nombre         as unidad_operativa_nombre,
  uo.codigo         as unidad_operativa_codigo,
  uo.proyecto       as unidad_operativa_proyecto,
  uo.ubicacion      as unidad_operativa_ubicacion,
  uo.zona           as unidad_operativa_zona,
  pr.razon_social   as proveedor_razon_social,
  pr.codigo         as proveedor_codigo,
  pr.ruc            as proveedor_ruc,
  d.total_items, d.total_cantidad, d.productos_resumen,
  d.busq_no_parte, d.busq_nombre, d.busq_ubicacion,
  d.estado_ids,
  d.busq_codigo_barras,
  -- Nueva: números de parte distintos, separados por coma, sin nulos.
  d.no_partes_resumen
from public.movimientos m
  join public.almacenes a on a.id = m.almacen_id
  left join public.usuarios u on u.id = m.usuario_id
  left join public.producto_unidad pu on pu.id = m.id_producto_unidad
  left join public.productos pup on pup.id = pu.producto_id
  left join public.equipos eq on eq.id = m.id_equipo
  left join public.unidad_operativa uo on uo.id = m.id_unidad_operativa
  left join public.proveedores pr on pr.id = m.id_proveedor
  left join lateral (
    select
      count(*)                                                   as total_items,
      coalesce(sum(md.cantidad), 0::numeric)                     as total_cantidad,
      string_agg(distinct p.nombre::text, ', '::text)            as productos_resumen,
      string_agg(distinct coalesce(p.no_parte, ''::varchar)::text, ' '::text)     as busq_no_parte,
      string_agg(distinct p.nombre::text, ' '::text)             as busq_nombre,
      string_agg(distinct coalesce(md.ubicacion, ''::varchar)::text, ' '::text)   as busq_ubicacion,
      array_remove(array_agg(distinct md.estado_id), null::bigint) as estado_ids,
      string_agg(distinct coalesce(p.codigo_barras, ''::varchar)::text, ' '::text) as busq_codigo_barras,
      string_agg(distinct p.no_parte::text, ', '::text)          as no_partes_resumen
    from public.movimiento_detalle md
      join public.productos p on p.id = md.producto_id
    where md.movimiento_id = m.id
  ) d on true;

grant select on public.vw_movimientos to authenticated;
