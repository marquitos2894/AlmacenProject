-- =====================================================================
-- 0010 — `activofijo` pasa a llamarse `es_trazable`, y `productos` suelta
--        los atributos que ahora pertenecen a la unidad física.
--
-- Contexto: `codigo_interno` ya se había eliminado a mano en Supabase. Ese
-- DROP ... CASCADE se llevó por delante las vistas `vw_producto_almacen` y
-- `vw_producto_unidad`, que este archivo reconstruye — sin ellas la pantalla
-- de Stock y el buscador de salidas quedan rotos.
--
-- Antes de borrar `no_serie` y `modelo` se traspasan a `producto_unidad`:
-- hay 3 productos con serie registrada (P50406, T406050, X103050) que de
-- otro modo se perderían para siempre.
--
-- Idempotente: puede re-ejecutarse en el SQL Editor de Supabase.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Rescatar las series ANTES de borrar las columnas
--    Se crea una unidad física por cada producto que tenga serie.
-- ---------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='productos' and column_name='no_serie'
  ) then
    -- `no_parte` vive solo en el catálogo (productos), no en la unidad.
    insert into public.producto_unidad (producto_id, modelo, no_serie, marca)
    select p.id, p.modelo, btrim(p.no_serie), p.marca
      from public.productos p
     where p.no_serie is not null
       and btrim(p.no_serie) <> ''
       and not exists (
         select 1 from public.producto_unidad u
          where u.producto_id = p.id
            and upper(btrim(u.no_serie)) = upper(btrim(p.no_serie))
       );
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. Soltar los índices y vistas que dependen de lo que se va a cambiar
-- ---------------------------------------------------------------------

drop index if exists public.uq_productos_no_serie;
drop index if exists public.idx_productos_no_serie;
drop index if exists public.uq_productos_no_parte_consumible;
drop index if exists public.uq_producto_almacen_activo_fijo;

drop view if exists public.vw_movimiento_detalle;
drop view if exists public.vw_producto_almacen;
drop view if exists public.vw_producto_unidad;

-- ---------------------------------------------------------------------
-- 3. Eliminar las columnas que ahora viven en producto_unidad
-- ---------------------------------------------------------------------

alter table public.productos drop column if exists no_serie;
alter table public.productos drop column if exists modelo;
alter table public.productos drop column if exists codigo_interno;

-- ---------------------------------------------------------------------
-- 4. Renombrar activo fijo -> es_trazable
--    El nombre nuevo describe mejor lo que hace la bandera: el artículo se
--    sigue pieza por pieza (por serie), en vez de contarse a granel.
-- ---------------------------------------------------------------------

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='productos' and column_name='activofijo') then
    alter table public.productos rename column activofijo to es_trazable;
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='producto_almacen' and column_name='es_activo_fijo') then
    alter table public.producto_almacen rename column es_activo_fijo to es_trazable;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 5. Recrear los índices con el nombre nuevo
-- ---------------------------------------------------------------------

-- Un consumible no repite número de parte; un trazable sí (varias unidades
-- del mismo modelo comparten no_parte y se distinguen por su serie).
create unique index if not exists uq_productos_no_parte_consumible
  on public.productos (upper(btrim(no_parte)))
  where no_parte is not null and btrim(no_parte) <> '' and activo and not es_trazable;

-- Un artículo trazable ocupa una sola existencia activa.
create unique index if not exists uq_producto_almacen_trazable
  on public.producto_almacen (producto_id)
  where es_trazable and activo;

-- ---------------------------------------------------------------------
-- 6. Funciones que leían la bandera vieja
-- ---------------------------------------------------------------------

create or replace function public.fn_pa_sync_trazable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  select coalesce(p.es_trazable, false)
    into new.es_trazable
    from public.productos p
   where p.id = new.producto_id;
  return new;
end $$;

drop trigger if exists trg_pa_sync_activo_fijo on public.producto_almacen;
drop trigger if exists trg_pa_sync_trazable on public.producto_almacen;
create trigger trg_pa_sync_trazable
  before insert or update of producto_id on public.producto_almacen
  for each row execute function public.fn_pa_sync_trazable();

create or replace function public.fn_productos_propagar_trazable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  if coalesce(new.es_trazable, false) is distinct from coalesce(old.es_trazable, false) then
    if coalesce(new.es_trazable, false) then
      select count(*) into v_count
        from public.producto_almacen
       where producto_id = new.id and activo;

      if v_count > 1 then
        raise exception
          'No se puede marcar "%" como trazable: tiene existencia en % almacenes. Debe quedar en uno solo.',
          new.nombre, v_count;
      end if;
    end if;

    update public.producto_almacen
       set es_trazable = coalesce(new.es_trazable, false)
     where producto_id = new.id;
  end if;
  return new;
end $$;

drop trigger if exists trg_productos_propagar_activo_fijo on public.productos;
drop trigger if exists trg_productos_propagar_trazable on public.productos;
create trigger trg_productos_propagar_trazable
  after update of es_trazable on public.productos
  for each row execute function public.fn_productos_propagar_trazable();

drop function if exists public.fn_pa_sync_activo_fijo();
drop function if exists public.fn_productos_propagar_activo_fijo();

-- ---------------------------------------------------------------------
-- 7. RPC de movimientos: misma lógica, bandera renombrada
-- ---------------------------------------------------------------------

create or replace function public.registrar_movimiento(
  p_almacen_id       bigint,
  p_fecha            date,
  p_tipo_movimiento  varchar,
  p_es_stock_inicial boolean,
  p_motivo           varchar,
  p_observaciones    text,
  p_usuario_id       bigint,
  p_items            jsonb
)
returns public.movimientos
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_mov         public.movimientos;
  v_item        jsonb;
  v_producto_id bigint;
  v_cantidad    numeric;
  v_estado_id   bigint;
  v_ubicacion   varchar;
  v_pa_id       bigint;
  v_pa          public.producto_almacen;
  v_nuevo       numeric;
  v_nombre      text;
  v_traz        boolean;
  v_otro        text;
  v_existente   numeric;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'El movimiento no tiene productos.';
  end if;

  insert into public.movimientos
    (almacen_id, fecha, tipo_movimiento, es_stock_inicial, motivo, observaciones, usuario_id)
  values
    (p_almacen_id, coalesce(p_fecha, current_date), p_tipo_movimiento,
     coalesce(p_es_stock_inicial, false), p_motivo, p_observaciones, p_usuario_id)
  returning * into v_mov;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_producto_id := (v_item ->> 'producto_id')::bigint;
    v_cantidad    := (v_item ->> 'cantidad')::numeric;
    v_estado_id   := nullif(v_item ->> 'estado_id', '')::bigint;
    v_ubicacion   := nullif(btrim(coalesce(v_item ->> 'ubicacion', '')), '');
    v_pa_id       := nullif(v_item ->> 'producto_almacen_id', '')::bigint;

    if v_cantidad is null or v_cantidad <= 0 then
      raise exception 'La cantidad debe ser mayor que cero.';
    end if;

    select nombre, coalesce(es_trazable, false)
      into v_nombre, v_traz
      from public.productos
     where id = v_producto_id;

    if v_nombre is null then
      raise exception 'El producto % no existe.', v_producto_id;
    end if;

    -- Un artículo trazable ya presente en inventario no vuelve a entrar.
    if v_traz and p_tipo_movimiento <> 'salida' and not coalesce(p_es_stock_inicial, false) then
      select coalesce(sum(stock_actual), 0) into v_existente
        from public.producto_almacen
       where producto_id = v_producto_id and activo;

      if v_existente > 0 then
        raise exception
          'El artículo trazable "%" ya está en inventario (stock %). Solo admite salidas; para reingresarlo, su stock debe quedar en cero.',
          coalesce(v_nombre, v_producto_id::text), v_existente;
      end if;
    end if;

    v_pa := null;

    if v_pa_id is not null then
      select * into v_pa from public.producto_almacen where id = v_pa_id;

      if not found then
        raise exception 'La existencia indicada no existe.';
      end if;
      if v_pa.producto_id <> v_producto_id or v_pa.almacen_id <> p_almacen_id then
        raise exception 'La existencia indicada no corresponde a "%" en este almacén.',
          coalesce(v_nombre, v_producto_id::text);
      end if;

    elsif v_traz then
      select a.nombre into v_otro
        from public.producto_almacen pa
        join public.almacenes a on a.id = pa.almacen_id
       where pa.producto_id = v_producto_id
         and pa.almacen_id <> p_almacen_id
         and pa.activo
       limit 1;

      if v_otro is not null then
        raise exception
          'El producto "%" es trazable y ya está asignado al almacén "%". Regístrale una salida allí antes de moverlo.',
          coalesce(v_nombre, v_producto_id::text), v_otro;
      end if;

      select * into v_pa
        from public.producto_almacen
       where producto_id = v_producto_id and almacen_id = p_almacen_id and activo
       limit 1;

      if found then
        update public.producto_almacen
           set estado_id = coalesce(v_estado_id, estado_id),
               ubicacion = coalesce(v_ubicacion, ubicacion),
               updated_at = now()
         where id = v_pa.id
        returning * into v_pa;
      end if;

    else
      select * into v_pa
        from public.producto_almacen
       where producto_id = v_producto_id
         and almacen_id  = p_almacen_id
         and activo
         and estado_id is not distinct from v_estado_id
         and ubicacion_norm is not distinct from nullif(upper(btrim(coalesce(v_ubicacion, ''))), '')
       limit 1;
    end if;

    if v_pa.id is null then
      insert into public.producto_almacen (producto_id, almacen_id, stock_actual, estado_id, ubicacion)
      values (v_producto_id, p_almacen_id, 0, v_estado_id, v_ubicacion)
      returning * into v_pa;
    end if;

    insert into public.movimiento_detalle
      (movimiento_id, producto_id, cantidad, estado_id, ubicacion, producto_almacen_id)
    values
      (v_mov.id, v_producto_id, v_cantidad, v_pa.estado_id, v_pa.ubicacion, v_pa.id);

    if coalesce(p_es_stock_inicial, false) then
      v_nuevo := v_cantidad;
    elsif p_tipo_movimiento = 'salida' then
      v_nuevo := coalesce(v_pa.stock_actual, 0) - v_cantidad;
    else
      v_nuevo := coalesce(v_pa.stock_actual, 0) + v_cantidad;
    end if;

    if v_nuevo < 0 then
      raise exception 'Stock insuficiente para "%" (estado/ubicación indicados): disponible %, solicitado %.',
        coalesce(v_nombre, v_producto_id::text), coalesce(v_pa.stock_actual, 0), v_cantidad;
    end if;

    update public.producto_almacen
       set stock_actual = v_nuevo, activo = true, updated_at = now()
     where id = v_pa.id;
  end loop;

  return v_mov;
end $$;

grant execute on function public.registrar_movimiento(
  bigint, date, varchar, boolean, varchar, text, bigint, jsonb
) to authenticated;

-- ---------------------------------------------------------------------
-- 8. Reconstruir las vistas
--    La serie ya no está en `productos`: cuando el artículo es trazable se
--    toma de sus unidades físicas.
-- ---------------------------------------------------------------------

create or replace view public.vw_producto_unidad
with (security_invoker = true) as
select
  u.id, u.producto_id, u.modelo, u.no_serie, u.codigo_interno,
  u.marca, u.estado_id, u.activo, u.created_at, u.updated_at,
  p.no_parte      as no_parte,
  p.nombre        as producto_nombre,
  p.codigo_barras as producto_codigo_barras,
  p.es_trazable   as producto_es_trazable,
  e.nombre        as estado_nombre
from public.producto_unidad u
join public.productos p on p.id = u.producto_id
left join public.estados e on e.id = u.estado_id
where u.activo = true;

create or replace view public.vw_producto_almacen
with (security_invoker = true) as
select
  pa.id, pa.producto_id, pa.almacen_id, pa.estado_id, pa.ubicacion,
  pa.stock_actual, pa.activo, pa.es_trazable, pa.created_at, pa.updated_at,
  p.nombre        as producto_nombre,
  p.no_parte      as no_parte,
  p.marca         as marca,
  p.codigo_barras as codigo_barras,
  a.nombre        as almacen_nombre,
  e.nombre        as estado_nombre,
  u.series        as no_serie
from public.producto_almacen pa
join public.productos p on p.id = pa.producto_id
join public.almacenes a on a.id = pa.almacen_id
left join public.estados e on e.id = pa.estado_id
left join lateral (
  select string_agg(btrim(pu.no_serie), ', ' order by btrim(pu.no_serie)) as series
    from public.producto_unidad pu
   where pu.producto_id = pa.producto_id and pu.activo
     and pu.no_serie is not null and btrim(pu.no_serie) <> ''
) u on true
where pa.activo = true;

create or replace view public.vw_movimiento_detalle
with (security_invoker = true) as
select
  md.id, md.movimiento_id, md.producto_id, md.producto_almacen_id,
  md.cantidad, md.estado_id, md.ubicacion,
  e.nombre        as estado_nombre,
  m.folio, m.fecha, m.tipo_movimiento, m.almacen_id,
  p.nombre        as producto_nombre,
  p.no_parte      as no_parte,
  p.codigo_barras as codigo_barras,
  u.series        as no_serie
from public.movimiento_detalle md
join public.movimientos m on m.id = md.movimiento_id
join public.productos p on p.id = md.producto_id
left join public.estados e on e.id = md.estado_id
left join lateral (
  select string_agg(btrim(pu.no_serie), ', ' order by btrim(pu.no_serie)) as series
    from public.producto_unidad pu
   where pu.producto_id = md.producto_id and pu.activo
     and pu.no_serie is not null and btrim(pu.no_serie) <> ''
) u on true;

grant select on public.vw_producto_unidad   to authenticated;
grant select on public.vw_producto_almacen  to authenticated;
grant select on public.vw_movimiento_detalle to authenticated;
