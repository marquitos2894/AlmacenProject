-- =====================================================================
-- 0062 — vw_stock_agrupado: códigos de barras, series y códigos internos.
--
-- "Stock por almacén" pasa a listar también los componentes (trazables), que
-- ya estaban en la vista: se agrupan por (almacén + n.º de parte) sin mirar
-- ubicación ni estado, igual que los consumibles (0044).
--
-- Problema: el código de barras de un componente es su serie o su código
-- interno (0039), distinto en cada unidad. La vista solo traía
-- `min(codigo_barras)` del grupo, así que escanear una unidad que no fuera la
-- "menor" no la encontraba, y tampoco se podía buscar por serie o código
-- interno. Se agregan, con `string_agg`, los valores de todo el grupo (mismo
-- patrón que `codigos_control`, 0051).
--
-- Las series y códigos internos salen de `producto_unidad` (solo activas) con
-- el mismo lateral que `vw_producto_almacen` (0046): uno por existencia, para
-- no multiplicar filas ni duplicar sumas.
--
-- `create or replace view` obliga a añadir las columnas al final; el grano y
-- las columnas actuales no cambian. Idempotente.
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
      order by nullif(btrim(pa.codigo_control::text), '')) as codigos_control,
    string_agg(distinct nullif(btrim(p.codigo_barras::text), ''), ', '
      order by nullif(btrim(p.codigo_barras::text), '')) as codigos_barras,
    string_agg(distinct u.series, ', ' order by u.series) as series,
    string_agg(distinct u.codigos, ', ' order by u.codigos) as codigos_internos
   from producto_almacen pa
     join productos p on p.id = pa.producto_id
     join almacenes a on a.id = pa.almacen_id
     left join lateral (
        select
          string_agg(nullif(btrim(pu.no_serie::text), ''), ', ' order by nullif(btrim(pu.no_serie::text), '')) as series,
          string_agg(nullif(btrim(pu.codigo_interno::text), ''), ', ' order by nullif(btrim(pu.codigo_interno::text), '')) as codigos
          from producto_unidad pu
         where pu.producto_id = pa.producto_id and pu.activo
     ) u on true
  where pa.activo = true
  group by pa.almacen_id, a.nombre, p.no_parte,
    (coalesce(nullif(btrim(p.no_parte::text), ''::text), 'prod:'::text || pa.producto_id::text));

grant select on public.vw_stock_agrupado to authenticated;
