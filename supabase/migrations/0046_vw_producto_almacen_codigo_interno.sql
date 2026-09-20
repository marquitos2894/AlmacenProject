-- =====================================================================
-- 0046 — vw_producto_almacen expone codigo_interno.
--
-- El buscador de "Agregar producto" en Movimientos ya podía filtrar por
-- código interno al dar entrada (vw_productos_busqueda lo trae). Al dar
-- salida, el mismo botón busca EXISTENCIAS (vw_producto_almacen), que no
-- tenía la columna. Se añade con el mismo criterio que no_serie: agregada
-- desde producto_unidad, en blanco cuando el componente no tiene código
-- interno (no debería pasar, pero por si acaso).
--
-- Columna añadida al final para que `create or replace view` no choque con
-- el orden de columnas existente.
-- =====================================================================

create or replace view public.vw_producto_almacen
with (security_invoker = true) as
 select pa.id,
    pa.producto_id,
    pa.almacen_id,
    pa.estado_id,
    pa.ubicacion,
    pa.stock_actual,
    pa.activo,
    pa.es_trazable,
    pa.created_at,
    pa.updated_at,
    p.nombre as producto_nombre,
    p.no_parte,
    p.marca,
    p.codigo_barras,
    a.nombre as almacen_nombre,
    e.nombre as estado_nombre,
    u.series as no_serie,
    pa.codigo_control,
    pa.codigo_control_norm,
    u.codigos as codigo_interno
   from producto_almacen pa
     join productos p on p.id = pa.producto_id
     join almacenes a on a.id = pa.almacen_id
     left join estados e on e.id = pa.estado_id
     left join lateral (
        select
          string_agg(nullif(btrim(pu.no_serie::text), ''), ', ' order by nullif(btrim(pu.no_serie::text), '')) as series,
          string_agg(nullif(btrim(pu.codigo_interno::text), ''), ', ' order by nullif(btrim(pu.codigo_interno::text), '')) as codigos
          from producto_unidad pu
         where pu.producto_id = pa.producto_id and pu.activo
     ) u on true
  where pa.activo = true;

grant select on public.vw_producto_almacen to authenticated;
