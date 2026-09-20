-- =====================================================================
-- 0053 — vw_producto_unidad_lista: expone la ubicación de la existencia.
--
-- El selector "Elegir producto activo" (Movimientos → Nuevo movimiento) usaba
-- `descripcion` (modelo/serie ó modelo/código interno, p. ej. "R1300/TCH-026-001")
-- como título — ilegible, porque no dice qué producto es. Se agrega
-- `ubicacion` a la misma subconsulta lateral que ya traía el estado, para que
-- el frontend pueda mostrar nombre del producto + serie/código interno como
-- título y no. de parte + ubicación como descripción secundaria.
--
-- `create or replace view` obliga a añadir la columna al final. Idempotente.
-- =====================================================================

create or replace view public.vw_producto_unidad_lista
with (security_invoker = true) as
select u.id,
       u.producto_id,
       u.modelo,
       u.no_serie,
       u.codigo_interno,
       u.marca,
       u.descripcion,
       pae.estado_id,
       u.activo,
       p.nombre  as producto_nombre,
       p.no_parte,
       e.nombre  as estado_nombre,
       pae.ubicacion
  from public.producto_unidad u
  join public.productos p on p.id = u.producto_id
  left join lateral (
    select pa.estado_id, pa.ubicacion
      from public.producto_almacen pa
     where pa.producto_id = u.producto_id and pa.activo
     order by pa.id
     limit 1
  ) pae on true
  left join public.estados e on e.id = pae.estado_id
 where u.activo;

grant select on public.vw_producto_unidad_lista to authenticated;
