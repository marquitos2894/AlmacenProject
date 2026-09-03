-- =====================================================================
-- 0036 — vw_transferencia_detalle: cabecera + identidad del componente.
--
-- La lista de Transferencias pasa a mostrar un renglón por línea de producto
-- (como Movimientos), con su n.º de parte y —solo para componentes— su serie
-- o código interno. La vista gana `motivo`, `created_at` (orden estable),
-- `es_trazable` y `codigo_interno` (mismo agregado que la serie).
--
-- `create or replace view` obliga a añadir las columnas al final.
-- Idempotente.
-- =====================================================================

create or replace view public.vw_transferencia_detalle
with (security_invoker = true) as
select td.id,
       td.transferencia_id,
       td.producto_id,
       td.cantidad,
       td.estado_id,
       e.nombre as estado_nombre,
       td.ubicacion_origen,
       td.ubicacion_destino,
       t.folio,
       t.fecha,
       t.almacen_origen_id,
       ao.nombre as almacen_origen_nombre,
       t.almacen_destino_id,
       ad.nombre as almacen_destino_nombre,
       p.nombre as producto_nombre,
       p.no_parte,
       p.codigo_barras,
       u.series as no_serie,
       t.motivo,
       t.created_at,
       coalesce(p.es_trazable, false) as es_trazable,
       u.codigos_internos as codigo_interno
  from public.transferencia_detalle td
  join public.transferencias t on t.id = td.transferencia_id
  join public.almacenes ao on ao.id = t.almacen_origen_id
  join public.almacenes ad on ad.id = t.almacen_destino_id
  join public.productos p on p.id = td.producto_id
  left join public.estados e on e.id = td.estado_id
  left join lateral (
    select string_agg(s.no_serie, ', '::text order by s.no_serie)             as series,
           string_agg(s.codigo_interno, ', '::text order by s.codigo_interno) as codigos_internos
      from (
        select nullif(btrim(pu.no_serie::text), '')       as no_serie,
               nullif(btrim(pu.codigo_interno::text), '')  as codigo_interno
          from public.producto_unidad pu
         where pu.producto_id = td.producto_id
           and pu.activo
      ) s
  ) u on true;

grant select on public.vw_transferencia_detalle to authenticated;
