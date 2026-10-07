-- =====================================================================
-- 0059 — "Pertenece a" (establecimiento) y etiquetas #hashtag en productos.
--
-- Problema: un componente suele pertenecer por defecto a un establecimiento
-- (UM Yauricocha, CM Kolpa…), pero la app no lo guardaba: la única pista era el
-- destino de la última salida (derivado de movimientos, `salida_unidad_operativa`),
-- que es otra cosa (dónde fue, no a quién pertenece).
--
-- Decisión:
--  * `productos.unidad_operativa_id`: FK opcional al catálogo de establecimientos.
--    Dato fijo que solo edita el usuario; las salidas NO lo tocan.
--  * `productos.etiquetas text[]`: etiquetas libres (#bomba, #mantenimiento…) para
--    agrupar productos y componentes. Un trigger las normaliza (minúsculas, sin
--    '#', espacios → '-', sin repetidas) para que "#Yauricocha" y "yauricocha"
--    sean la misma y los filtros/conteos no se descuadren.
--  * El establecimiento NO se copia a `etiquetas`: es un único dato canónico.
--
-- Vive en `productos` (precedente: 0057 tipos_producto); el campo del formulario
-- "Pertenece a" solo se muestra en componentes. RLS sin cambios: las columnas
-- nuevas heredan las políticas de `productos`.
--
-- Idempotente.
-- =====================================================================

alter table public.productos
  add column if not exists unidad_operativa_id bigint
    references public.unidad_operativa(id) on delete set null;

alter table public.productos
  add column if not exists etiquetas text[] not null default '{}';

create index if not exists idx_productos_unidad_operativa on public.productos (unidad_operativa_id);
create index if not exists idx_productos_etiquetas on public.productos using gin (etiquetas);

-- ─────────────────────────────────────────────────────────────────────────────
-- Normalización de etiquetas: máx. 10 por producto, 30 caracteres cada una.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.fn_productos_normaliza_etiquetas()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  select coalesce(array_agg(t order by o), '{}')
    into new.etiquetas
    from (
      select t, min(o) as o
        from (
          select left(
                   regexp_replace(
                     regexp_replace(
                       regexp_replace(lower(btrim(e)), '^#+', ''),
                       '\s+', '-', 'g'),
                     '[^a-z0-9áéíóúñü_-]', '', 'g'),
                   30) as t,
                 o
            from unnest(coalesce(new.etiquetas, '{}')) with ordinality as x(e, o)
        ) n
       where t <> ''
       group by t
       order by min(o)
       limit 10
    ) d;
  return new;
end;
$$;

drop trigger if exists trg_productos_etiquetas on public.productos;
create trigger trg_productos_etiquetas
  before insert or update of etiquetas on public.productos
  for each row execute function public.fn_productos_normaliza_etiquetas();

-- ─────────────────────────────────────────────────────────────────────────────
-- vw_etiquetas_producto: etiquetas en uso y cuántos productos activos las llevan
-- (opciones del filtro "Etiqueta").
-- ─────────────────────────────────────────────────────────────────────────────

create or replace view public.vw_etiquetas_producto
with (security_invoker = true) as
 select t.etiqueta,
        count(*)::integer as usos
   from public.productos p
  cross join lateral unnest(p.etiquetas) as t(etiqueta)
  where p.activo
  group by t.etiqueta;

grant select on public.vw_etiquetas_producto to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- vw_productos_trazables: expone el establecimiento (id + nombre) y las
-- etiquetas al final. El join no filtra `activo`: si el establecimiento se
-- desactiva, el componente sigue mostrando a cuál pertenecía.
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
    tp.nombre as tipo_producto_nombre,
    p.unidad_operativa_id,
    uop.nombre as unidad_operativa_nombre,
    p.etiquetas
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
     left join public.tipos_producto tp on tp.id = p.tipo_producto_id
     left join public.unidad_operativa uop on uop.id = p.unidad_operativa_id;

grant select on public.vw_productos_trazables to authenticated;
