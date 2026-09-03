-- =====================================================================
-- 0035 — vw_movimiento_detalle: identidad del componente.
--
-- La lista y el ticket de Movimientos muestran, solo para los componentes, su
-- serie o su código interno. La vista ya agregaba la serie de las unidades del
-- producto; se añade `codigo_interno` (mismo agregado) y `es_trazable` para
-- poder distinguir componente de consumible en el frontend.
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
       m.created_at,
       coalesce(p.es_trazable, false) as es_trazable,
       u.codigos_internos as codigo_interno
  from public.movimiento_detalle md
  join public.movimientos m on m.id = md.movimiento_id
  join public.productos p on p.id = md.producto_id
  left join public.estados e on e.id = md.estado_id
  left join lateral (
    select string_agg(s.no_serie, ', '::text order by s.no_serie)             as series,
           string_agg(s.codigo_interno, ', '::text order by s.codigo_interno) as codigos_internos
      from (
        select nullif(btrim(pu.no_serie::text), '')       as no_serie,
               nullif(btrim(pu.codigo_interno::text), '')  as codigo_interno
          from public.producto_unidad pu
         where pu.producto_id = md.producto_id
           and pu.activo
      ) s
  ) u on true;

grant select on public.vw_movimiento_detalle to authenticated;
