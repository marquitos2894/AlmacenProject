-- 0023 — Estado y ubicación del componente trazable: una sola fuente de verdad.
--
-- El estado vivía duplicado en producto_unidad.estado_id (formulario de
-- Productos) y en producto_almacen.estado_id (Movimientos / Stock), sin
-- sincronía → deriva (p. ej. una unidad "Dañado" con su existencia en "Baja").
--
-- Se deja UNA canónica: producto_almacen (donde ya viven ubicación y stock, y
-- que es lo que escribe el flujo auditado de Movimientos). `productos` gana
-- estado_actual / ubicacion_actual DERIVADAS por trigger, igual que `equipos`.
-- Se elimina producto_unidad.estado_id.

-- 1) Columnas derivadas en productos
alter table public.productos
  add column if not exists estado_actual    varchar,
  add column if not exists ubicacion_actual varchar;

-- 2) Trigger que sincroniza productos.estado_actual / ubicacion_actual desde la
--    existencia trazable (1:1) ante cualquier cambio en producto_almacen.
create or replace function public.fn_productos_sync_actual()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_prod bigint := coalesce(new.producto_id, old.producto_id);
begin
  if v_prod is null then
    return null;
  end if;

  update public.productos p
     set estado_actual    = sub.estado_nombre,
         ubicacion_actual = sub.ubicacion
    from (
      select es.nombre as estado_nombre, pa.ubicacion
        from public.producto_almacen pa
        left join public.estados es on es.id = pa.estado_id
       where pa.producto_id = v_prod and pa.activo
       order by pa.id
       limit 1
    ) sub
   where p.id = v_prod and p.es_trazable;

  -- Sin existencia activa: se limpia.
  update public.productos p
     set estado_actual = null, ubicacion_actual = null
   where p.id = v_prod and p.es_trazable
     and not exists (
       select 1 from public.producto_almacen pa where pa.producto_id = v_prod and pa.activo
     );

  return null;
end $fn$;

drop trigger if exists trg_productos_sync_actual on public.producto_almacen;
create trigger trg_productos_sync_actual
  after insert or delete or update of estado_id, ubicacion, activo, producto_id
  on public.producto_almacen
  for each row execute function public.fn_productos_sync_actual();

-- 3) Backfill (el trazable tiene una única existencia activa)
update public.productos p
   set estado_actual   = sub.estado_nombre,
       ubicacion_actual = sub.ubicacion
  from (
    select pa.producto_id,
           (select nombre from public.estados where id = pa.estado_id) as estado_nombre,
           pa.ubicacion
      from public.producto_almacen pa
     where pa.activo
  ) sub
 where p.id = sub.producto_id and p.es_trazable;

-- 4) set_producto_unidad deja de gestionar estado (vive en producto_almacen)
drop function if exists public.set_producto_unidad(bigint, character varying, character varying, character varying, bigint);

create or replace function public.set_producto_unidad(
  p_producto_id bigint,
  p_modelo character varying,
  p_no_serie character varying,
  p_codigo_interno character varying
) returns bigint
language plpgsql
set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_traz  boolean;
  v_marca character varying;
  v_id    bigint;
begin
  if p_producto_id is null then
    raise exception 'Falta el producto.';
  end if;

  select coalesce(es_trazable, false), marca
    into v_traz, v_marca
    from public.productos
   where id = p_producto_id;

  if not found then
    raise exception 'El producto % no existe.', p_producto_id;
  end if;

  if not v_traz then
    update public.producto_unidad
       set activo = false, updated_at = now()
     where producto_id = p_producto_id and activo;
    return null;
  end if;

  select id into v_id
    from public.producto_unidad
   where producto_id = p_producto_id and activo
   order by id
   limit 1;

  if found then
    update public.producto_unidad
       set modelo         = nullif(btrim(coalesce(p_modelo, '')), ''),
           no_serie       = nullif(btrim(coalesce(p_no_serie, '')), ''),
           codigo_interno = nullif(btrim(coalesce(p_codigo_interno, '')), ''),
           marca          = v_marca,
           updated_at     = now()
     where id = v_id;
  else
    insert into public.producto_unidad
      (producto_id, modelo, no_serie, codigo_interno, marca)
    values
      (p_producto_id,
       nullif(btrim(coalesce(p_modelo, '')), ''),
       nullif(btrim(coalesce(p_no_serie, '')), ''),
       nullif(btrim(coalesce(p_codigo_interno, '')), ''),
       v_marca)
    returning id into v_id;
  end if;

  return v_id;
end $fn$;

grant execute on function public.set_producto_unidad(bigint, character varying, character varying, character varying) to authenticated;

-- 5) Vistas: el estado (y la ubicación) del trazable salen de producto_almacen.
create or replace view public.vw_producto_unidad with (security_invoker = true) as
select u.id,
       u.producto_id,
       u.modelo,
       u.no_serie,
       u.codigo_interno,
       u.marca,
       pae.estado_id,
       u.activo,
       u.created_at,
       u.updated_at,
       p.no_parte,
       p.nombre        as producto_nombre,
       p.codigo_barras as producto_codigo_barras,
       p.es_trazable   as producto_es_trazable,
       e.nombre        as estado_nombre
  from public.producto_unidad u
  join public.productos p on p.id = u.producto_id
  left join lateral (
    select pa.estado_id
      from public.producto_almacen pa
     where pa.producto_id = u.producto_id and pa.activo
     order by pa.id
     limit 1
  ) pae on true
  left join public.estados e on e.id = pae.estado_id
 where u.activo = true;

create or replace view public.vw_producto_unidad_lista with (security_invoker = true) as
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
       e.nombre  as estado_nombre
  from public.producto_unidad u
  join public.productos p on p.id = u.producto_id
  left join lateral (
    select pa.estado_id
      from public.producto_almacen pa
     where pa.producto_id = u.producto_id and pa.activo
     order by pa.id
     limit 1
  ) pae on true
  left join public.estados e on e.id = pae.estado_id
 where u.activo;

create or replace view public.vw_productos_busqueda with (security_invoker = true) as
select p.id,
       p.nombre,
       p.no_parte,
       p.marca,
       p.codigo_barras,
       p.es_trazable,
       p.activo,
       u.no_serie,
       u.codigo_interno,
       u.modelo,
       u.descripcion as unidad_descripcion
  from public.productos p
  left join lateral (
    select pu.no_serie, pu.codigo_interno, pu.modelo, pu.descripcion
      from public.producto_unidad pu
     where pu.producto_id = p.id and pu.activo
     order by pu.id
     limit 1
  ) u on true;

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
       a.nombre  as almacen_nombre
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
  ) n on true;

-- 6) Se elimina la columna duplicada (arrastra su FK).
alter table public.producto_unidad drop column if exists estado_id;
