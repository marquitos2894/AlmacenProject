-- vw_stock_agrupado vuelve a agrupar solo por (almacén, n.º de parte).
--
-- La migración 0042 llevó el grano de esta vista a
-- (almacén + n.º de parte + ubicación + estado + código de control), de modo que
-- un mismo producto guardado en dos ubicaciones aparecía en dos filas en
-- "Stock por almacén". El equipo la quiere de nuevo con UNA fila por producto:
-- si el n.º de parte tiene varias existencias se ve como una sola fila con la
-- cuenta de existencias (`total_existencias`) y de ubicaciones
-- (`total_ubicaciones`); el desglose por ubicación/estado/código de control
-- queda en el modal "Ver detalles". El `stock_total` de la fila es la suma de
-- todas sus existencias, sin separar por estado.
--
-- `estado_ids` = estados presentes entre las existencias del producto; deja que
-- el filtro por estado de la vista signifique "tiene alguna existencia en ese
-- estado". `producto_id` = id del producto de la fila, para que el modal de
-- detalle consulte exactamente sus existencias.
--
-- Cambia la lista de columnas, así que hay drop + create (no `create or
-- replace`). Ningún otro objeto de la base depende de esta vista.

drop view if exists public.vw_stock_agrupado;
create view public.vw_stock_agrupado
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
    bool_or(pa.es_trazable) as es_trazable
   from producto_almacen pa
     join productos p on p.id = pa.producto_id
     join almacenes a on a.id = pa.almacen_id
  where pa.activo = true
  group by pa.almacen_id, a.nombre, p.no_parte,
    (coalesce(nullif(btrim(p.no_parte::text), ''::text), 'prod:'::text || pa.producto_id::text));

grant select on public.vw_stock_agrupado to authenticated;
