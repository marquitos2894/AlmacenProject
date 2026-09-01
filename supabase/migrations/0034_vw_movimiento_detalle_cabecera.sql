-- =====================================================================
-- 0034 — vw_movimiento_detalle: columnas de cabecera para la lista.
--
-- La lista de Movimientos pasa a mostrar un renglón por línea de producto
-- (sin agrupar por ticket). Para ello `vw_movimiento_detalle` necesita
-- exponer también `es_stock_inicial` (para la insignia de tipo), `motivo` y
-- `created_at` (orden estable "más reciente primero").
--
-- `create or replace view` obliga a añadir las columnas al final.
-- Idempotente.
-- =====================================================================

create or replace view public.vw_movimiento_detalle
with (security_invoker = true) as
select md.id,
       md.movimiento_id,
       md.producto_id,
       md.producto_almacen_id,
       md.cantidad,
       md.estado_id,
       md.ubicacion,
       e.nombre as estado_nombre,
       m.folio,
       m.fecha,
       m.tipo_movimiento,
       m.almacen_id,
       p.nombre as producto_nombre,
       p.no_parte,
       p.codigo_barras,
       u.series as no_serie,
       m.es_stock_inicial,
       m.motivo,
       m.created_at
  from public.movimiento_detalle md
  join public.movimientos m on m.id = md.movimiento_id
  join public.productos p on p.id = md.producto_id
  left join public.estados e on e.id = md.estado_id
  left join lateral (
    select string_agg(btrim(pu.no_serie::text), ', '::text order by (btrim(pu.no_serie::text))) as series
      from public.producto_unidad pu
     where pu.producto_id = md.producto_id
       and pu.activo
       and pu.no_serie is not null
       and btrim(pu.no_serie::text) <> ''::text
  ) u on true;

grant select on public.vw_movimiento_detalle to authenticated;
