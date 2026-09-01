-- =====================================================================
-- 0029 — `vw_productos_trazables.salida_equipo` con código asignado.
--
-- La tarjeta del componente sin existencia muestra a dónde se fue en su
-- última salida, como dos chips: unidad operativa y equipo. El equipo se
-- quiere ver como "modelo/serie/código asignado" (igual que en los
-- selectores y en "Elegir equipo"), así que `salida_equipo` pasa a incluir
-- el código de la asignación vigente del equipo.
--
-- Solo cambia la expresión de `salida_equipo`; el resto de la vista queda
-- igual que en 0028. Idempotente.
-- =====================================================================

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
                     nullif(btrim(eq.no_serie::text), ''::text),
                     nullif(btrim(vae.codigo_asignado::text), ''::text)) as equipo_etiqueta
      from public.movimiento_detalle md
      join public.movimientos m on m.id = md.movimiento_id
      left join public.unidad_operativa uo on uo.id = m.id_unidad_operativa
      left join public.equipos eq on eq.id = m.id_equipo
      left join lateral (
        select a2.codigo_asignado
          from public.equipo_unidad_operativa a2
         where a2.equipo_id = m.id_equipo and a2.activo and a2.fecha_fin is null
         order by a2.fecha_inicio desc, a2.id desc
         limit 1
      ) vae on true
     where md.producto_id = p.id
       and m.tipo_movimiento = 'salida'
       and (m.id_unidad_operativa is not null or m.id_equipo is not null)
     order by m.fecha desc, m.id desc
     limit 1
  ) sal on true;

grant select on public.vw_productos_trazables to authenticated;
