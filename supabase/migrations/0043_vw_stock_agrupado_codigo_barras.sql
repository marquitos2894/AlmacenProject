-- Añade `codigo_barras` a vw_stock_agrupado.
--
-- La vista "Stock por almacén" ahora consulta esta vista agregada de forma
-- paginada en el servidor (una página cada vez, no toda la tabla). Para que el
-- filtro por código de barras —que se fija escaneando— también viaje por esa
-- consulta agregada, la vista necesita exponer la columna; antes solo estaba en
-- vw_producto_almacen (detalle) y obligaba a traer y agrupar en el cliente.
--
-- Cada fila de vw_stock_agrupado agrupa por n.º de parte, y en consumibles
-- activos el n.º de parte es único (uq_productos_no_parte_consumible), así que
-- `min(p.codigo_barras)` es el código de barras de ese producto. La columna se
-- añade al final para no romper `create or replace view`.

create or replace view public.vw_stock_agrupado
with (security_invoker = true) as
 select pa.almacen_id,
    a.nombre as almacen_nombre,
    p.no_parte,
    min(p.nombre::text) as producto_nombre,
    pa.ubicacion_norm,
    min(pa.ubicacion::text) as ubicacion,
    pa.estado_id,
    e.nombre as estado_nombre,
    pa.codigo_control_norm,
    min(pa.codigo_control::text) as codigo_control,
    sum(pa.stock_actual) as stock_total,
    count(distinct pa.producto_id) as total_series,
    count(*) as total_existencias,
    min(p.marca::text) as marca,
    bool_or(pa.es_trazable) as es_trazable,
    min(p.codigo_barras::text) as codigo_barras
   from producto_almacen pa
     join productos p on p.id = pa.producto_id
     join almacenes a on a.id = pa.almacen_id
     left join estados e on e.id = pa.estado_id
  where pa.activo = true
  group by pa.almacen_id, a.nombre, p.no_parte,
    (coalesce(nullif(btrim(p.no_parte::text), ''::text), 'prod:'::text || pa.producto_id::text)),
    pa.ubicacion_norm, pa.estado_id, e.nombre, pa.codigo_control_norm;

grant select on public.vw_stock_agrupado to authenticated;
