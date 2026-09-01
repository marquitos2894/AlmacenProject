-- =====================================================================
-- 0028 — Etiqueta de equipo con código asignado + destino de la última
--        salida de un componente.
--
-- (1) vw_productos_trazables: cuando el componente ya no tiene existencia
--     activa (salió por completo del inventario), no basta con "Sin
--     existencia". Se expone a dónde se fue según su última salida:
--     `salida_unidad_operativa` y `salida_equipo` (de las referencias del
--     ticket de esa salida).
--
-- (2) vw_equipos_lista: `etiqueta` pasa a ser "modelo/serie/código asignado"
--     (el código asignado de la asignación vigente) y se añade la columna
--     `codigo_asignado` para poder buscar por ella. Alimenta los selectores
--     de equipo y el modal "Elegir equipo".
--
-- Idempotente.
-- =====================================================================

-- --------------------------------------------------- vw_productos_trazables
create or replace view public.vw_productos_trazables with (security_invoker = true) as
select p.id,
       p.nombre,
       p.no_parte,
       p.marca,
       p.codigo_erp,
       p.descripcion,
       p.equipos_compatible,
       p.unidad_medida_id,
       p.codigo_barras,
       p.es_trazable,
       p.activo,
       p.created_at,
       p.updated_at,
       u.no_serie,
       u.codigo_interno,
       u.modelo,
       pae.estado_id,
       e.nombre  as estado_nombre,
       coalesce(n.total, 0) as unidades,
       pae.id           as producto_almacen_id,
       pae.ubicacion,
       pae.almacen_id,
       a.nombre  as almacen_nombre,
       -- Destino de la última salida (solo relevante cuando no hay existencia).
       sal.unidad_operativa_nombre as salida_unidad_operativa,
       sal.equipo_etiqueta         as salida_equipo
  from public.productos p
  left join lateral (
    select pu.no_serie, pu.codigo_interno, pu.modelo
      from public.producto_unidad pu
     where pu.producto_id = p.id and pu.activo
     order by pu.id
     limit 1
  ) u on true
  left join lateral (
    select pa.id, pa.estado_id, pa.ubicacion, pa.almacen_id
      from public.producto_almacen pa
     where pa.producto_id = p.id and pa.activo
     order by pa.id
     limit 1
  ) pae on true
  left join public.estados e on e.id = pae.estado_id
  left join public.almacenes a on a.id = pae.almacen_id
  left join lateral (
    select count(*)::integer as total
      from public.producto_unidad pu2
     where pu2.producto_id = p.id and pu2.activo
  ) n on true
  left join lateral (
    select uo.nombre as unidad_operativa_nombre,
           concat_ws('/'::text,
                     nullif(btrim(eq.modelo::text), ''::text),
                     nullif(btrim(eq.no_serie::text), ''::text)) as equipo_etiqueta
      from public.movimiento_detalle md
      join public.movimientos m on m.id = md.movimiento_id
      left join public.unidad_operativa uo on uo.id = m.id_unidad_operativa
      left join public.equipos eq on eq.id = m.id_equipo
     where md.producto_id = p.id
       and m.tipo_movimiento = 'salida'
       and (m.id_unidad_operativa is not null or m.id_equipo is not null)
     order by m.fecha desc, m.id desc
     limit 1
  ) sal on true;

grant select on public.vw_productos_trazables to authenticated;

-- ------------------------------------------------------- vw_equipos_lista
create or replace view public.vw_equipos_lista with (security_invoker = true) as
select e.id,
       e.modelo,
       e.marca,
       e.no_serie,
       e.unidad_actual,
       e.estado_actual,
       e.descripcion,
       e.activo,
       concat_ws('/'::text,
                 nullif(btrim(e.modelo::text), ''::text),
                 nullif(btrim(e.no_serie::text), ''::text),
                 nullif(btrim(vig.codigo_asignado::text), ''::text)) as etiqueta,
       vig.codigo_asignado
  from public.equipos e
  left join lateral (
    select a.codigo_asignado
      from public.equipo_unidad_operativa a
     where a.equipo_id = e.id and a.activo and a.fecha_fin is null
     order by a.fecha_inicio desc, a.id desc
     limit 1
  ) vig on true
 where e.activo;

grant select on public.vw_equipos_lista to authenticated;
