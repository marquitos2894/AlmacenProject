-- =====================================================================
-- 0051 — vw_stock_agrupado: código(s) de control del producto en el almacén.
--
-- "Stock por almacén" agrupa todas las existencias de un mismo n.º de parte
-- en un almacén en una sola fila (0044); si esas existencias tienen distinto
-- código de control, la fila puede reunir más de uno. Se agregan con
-- `string_agg` (mismo patrón que `no_serie` en vw_producto_almacen), en orden,
-- separados por coma, para poder mostrarlos y para poder buscar por ellos.
--
-- `create or replace view` obliga a añadir la columna al final. Idempotente.
-- =====================================================================

create or replace view public.vw_stock_agrupado
with (security_invoker = true) as
 select pa.almacen_id,
    a.nombre as almacen_nombre,
    min(pa.producto_id) as producto_id,
    p.no_parte,
    min(p.nombre::text) as producto_nombre,
    min(p.marca::text) as marca,
    min(p.codigo_barras::text) as codigo_barras,
    sum(pa.stock_actual) as stock_total,
    count(distinct pa.producto_id) as total_series,
    count(*) as total_existencias,
    count(distinct pa.ubicacion_norm) as total_ubicaciones,
    array_agg(distinct pa.estado_id) filter (where pa.estado_id is not null) as estado_ids,
    bool_or(pa.es_trazable) as es_trazable,
    string_agg(distinct nullif(btrim(pa.codigo_control::text), ''), ', '
      order by nullif(btrim(pa.codigo_control::text), '')) as codigos_control
   from producto_almacen pa
     join productos p on p.id = pa.producto_id
     join almacenes a on a.id = pa.almacen_id
  where pa.activo = true
  group by pa.almacen_id, a.nombre, p.no_parte,
    (coalesce(nullif(btrim(p.no_parte::text), ''::text), 'prod:'::text || pa.producto_id::text));

grant select on public.vw_stock_agrupado to authenticated;
