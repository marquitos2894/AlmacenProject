-- =====================================================================
-- 0057 — Catálogo "Tipos de producto" y atributo en productos.
--
-- `tipos_producto` sigue el mismo patrón que `tipos_equipo` (0047) y
-- `estados`: catálogo simple, lectura abierta y escritura solo para
-- editores (puede_editar()). `productos.tipo_producto_id` es una llave
-- foránea opcional (on delete set null): desactivar o borrar un tipo no
-- debe romper los productos que ya lo tenían asignado.
--
-- Vive en `productos` (no solo en componentes) porque no hay una tabla
-- separada para componentes — pero el campo del formulario y el dashboard
-- que lo usan son específicos de Componentes (productos trazables).
--
-- Idempotente.
-- =====================================================================

create table if not exists public.tipos_producto (
  id          bigint generated always as identity primary key,
  nombre      character varying not null,
  descripcion text,
  activo      boolean not null default true
);

alter table public.tipos_producto enable row level security;

drop policy if exists tipos_producto_select on public.tipos_producto;
create policy tipos_producto_select on public.tipos_producto
  for select using (true);

drop policy if exists tipos_producto_insert on public.tipos_producto;
create policy tipos_producto_insert on public.tipos_producto
  for insert with check (puede_editar());

drop policy if exists tipos_producto_update on public.tipos_producto;
create policy tipos_producto_update on public.tipos_producto
  for update using (puede_editar()) with check (puede_editar());

drop policy if exists tipos_producto_delete on public.tipos_producto;
create policy tipos_producto_delete on public.tipos_producto
  for delete using (puede_editar());

grant select, insert, update, delete on public.tipos_producto to authenticated;

alter table public.productos
  add column if not exists tipo_producto_id bigint references public.tipos_producto(id) on delete set null;

create index if not exists idx_productos_tipo_producto on public.productos (tipo_producto_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- vw_productos_trazables: expone el tipo de producto (id + nombre) al final.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace view public.vw_productos_trazables
with (security_invoker = true) as
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
    e.nombre as estado_nombre,
    coalesce(n.total, 0) as unidades,
    pae.id as producto_almacen_id,
    pae.ubicacion,
    pae.almacen_id,
    a.nombre as almacen_nombre,
    sal.unidad_operativa_nombre as salida_unidad_operativa,
    sal.equipo_etiqueta as salida_equipo,
    pae.codigo_control,
    p.tipo_producto_id,
    tp.nombre as tipo_producto_nombre
   from productos p
     left join lateral ( select pu.no_serie, pu.codigo_interno, pu.modelo
           from producto_unidad pu
          where pu.producto_id = p.id and pu.activo
          order by pu.id
         limit 1) u on true
     left join lateral ( select pa.id, pa.estado_id, pa.ubicacion, pa.almacen_id, pa.codigo_control
           from producto_almacen pa
          where pa.producto_id = p.id and pa.activo
          order by pa.id
         limit 1) pae on true
     left join estados e on e.id = pae.estado_id
     left join almacenes a on a.id = pae.almacen_id
     left join lateral ( select count(*)::integer as total
           from producto_unidad pu2
          where pu2.producto_id = p.id and pu2.activo) n on true
     left join lateral ( select uo.nombre as unidad_operativa_nombre,
            concat_ws('/'::text, nullif(btrim(eq.modelo::text), ''::text), nullif(btrim(eq.no_serie::text), ''::text), nullif(btrim(vae.codigo_asignado::text), ''::text)) as equipo_etiqueta
           from movimiento_detalle md
             join movimientos m on m.id = md.movimiento_id
             left join unidad_operativa uo on uo.id = m.id_unidad_operativa
             left join equipos eq on eq.id = m.id_equipo
             left join lateral ( select a2.codigo_asignado
                   from equipo_unidad_operativa a2
                  where a2.equipo_id = m.id_equipo and a2.activo and a2.fecha_fin is null
                  order by a2.fecha_inicio desc, a2.id desc
                 limit 1) vae on true
          where md.producto_id = p.id and m.tipo_movimiento::text = 'salida'::text and (m.id_unidad_operativa is not null or m.id_equipo is not null)
          order by m.fecha desc, m.id desc
         limit 1) sal on true
     left join public.tipos_producto tp on tp.id = p.tipo_producto_id;

grant select on public.vw_productos_trazables to authenticated;
