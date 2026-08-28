-- =====================================================================
-- 0003 — Regla de negocio: un producto marcado como ACTIVO FIJO solo puede
--        existir en UN almacén (una sola fila activa en producto_almacen).
--
-- Se impone en la base de datos con un índice único parcial, de modo que
-- la regla resiste concurrencia y no depende del frontend.
--
-- Idempotente: puede re-ejecutarse en el SQL Editor de Supabase.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Columna espejo en producto_almacen
--    (un índice parcial no puede consultar otra tabla, así que se
--     denormaliza el flag y se mantiene sincronizado por trigger)
-- ---------------------------------------------------------------------

alter table public.producto_almacen
  add column if not exists es_activo_fijo boolean not null default false;

create or replace function public.fn_pa_sync_activo_fijo()
returns trigger
language plpgsql
as $$
begin
  select coalesce(p.activofijo, false)
    into new.es_activo_fijo
    from public.productos p
   where p.id = new.producto_id;
  return new;
end $$;

drop trigger if exists trg_pa_sync_activo_fijo on public.producto_almacen;
create trigger trg_pa_sync_activo_fijo
  before insert or update of producto_id on public.producto_almacen
  for each row execute function public.fn_pa_sync_activo_fijo();

-- Backfill del flag para las filas existentes
update public.producto_almacen pa
   set es_activo_fijo = coalesce(p.activofijo, false)
  from public.productos p
 where p.id = pa.producto_id
   and pa.es_activo_fijo is distinct from coalesce(p.activofijo, false);

-- ---------------------------------------------------------------------
-- 2. La regla: como máximo una fila ACTIVA por producto de activo fijo.
--    (Si la fila se desactiva, el activo queda libre para reasignarse.)
-- ---------------------------------------------------------------------

create unique index if not exists uq_producto_almacen_activo_fijo
  on public.producto_almacen (producto_id)
  where es_activo_fijo and activo;

-- ---------------------------------------------------------------------
-- 3. Propagar el cambio cuando se marca/desmarca activo fijo en el producto
-- ---------------------------------------------------------------------

create or replace function public.fn_productos_propagar_activo_fijo()
returns trigger
language plpgsql
as $$
declare
  v_count int;
begin
  if coalesce(new.activofijo, false) is distinct from coalesce(old.activofijo, false) then
    if coalesce(new.activofijo, false) then
      select count(*) into v_count
        from public.producto_almacen
       where producto_id = new.id and activo;

      if v_count > 1 then
        raise exception
          'No se puede marcar "%" como activo fijo: tiene existencia en % almacenes. Debe quedar en uno solo.',
          new.nombre, v_count;
      end if;
    end if;

    update public.producto_almacen
       set es_activo_fijo = coalesce(new.activofijo, false)
     where producto_id = new.id;
  end if;
  return new;
end $$;

drop trigger if exists trg_productos_propagar_activo_fijo on public.productos;
create trigger trg_productos_propagar_activo_fijo
  after update of activofijo on public.productos
  for each row execute function public.fn_productos_propagar_activo_fijo();

-- ---------------------------------------------------------------------
-- 4. RPC de registro — mismo comportamiento que en 0002 más la validación
--    de activo fijo, con un mensaje entendible para el usuario.
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
as $$
declare
  v_mov         public.movimientos;
  v_item        jsonb;
  v_producto_id bigint;
  v_cantidad    numeric;
  v_costo       numeric;
  v_pa          public.producto_almacen;
  v_nuevo       numeric;
  v_nombre      text;
  v_fijo        boolean;
  v_otro        text;
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
    v_costo       := coalesce((v_item ->> 'costo_unitario')::numeric, 0);

    if v_cantidad is null or v_cantidad <= 0 then
      raise exception 'La cantidad debe ser mayor que cero.';
    end if;

    select nombre, coalesce(activofijo, false)
      into v_nombre, v_fijo
      from public.productos
     where id = v_producto_id;

    -- Regla de activo fijo: no puede existir en otro almacén
    if v_fijo then
      select a.nombre into v_otro
        from public.producto_almacen pa
        join public.almacenes a on a.id = pa.almacen_id
       where pa.producto_id = v_producto_id
         and pa.almacen_id <> p_almacen_id
         and pa.activo
       limit 1;

      if v_otro is not null then
        raise exception
          'El producto "%" es un activo fijo y ya está asignado al almacén "%". Regístrale una salida allí antes de moverlo.',
          coalesce(v_nombre, v_producto_id::text), v_otro;
      end if;
    end if;

    insert into public.movimiento_detalle (movimiento_id, producto_id, cantidad, costo_unitario)
    values (v_mov.id, v_producto_id, v_cantidad, v_costo);

    select * into v_pa
      from public.producto_almacen
     where producto_id = v_producto_id and almacen_id = p_almacen_id
     limit 1;

    if not found then
      insert into public.producto_almacen (producto_id, almacen_id, stock_actual)
      values (v_producto_id, p_almacen_id, 0)
      returning * into v_pa;
    end if;

    if coalesce(p_es_stock_inicial, false) then
      v_nuevo := v_cantidad;                                   -- Stock Inicial: sobrescribe
    elsif p_tipo_movimiento = 'salida' then
      v_nuevo := coalesce(v_pa.stock_actual, 0) - v_cantidad;  -- Salida: resta
    else
      v_nuevo := coalesce(v_pa.stock_actual, 0) + v_cantidad;  -- Entrada: suma
    end if;

    if v_nuevo < 0 then
      raise exception 'Stock insuficiente para "%": disponible %, solicitado %.',
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
-- 5. Exponer el flag en la vista de stock (para mostrarlo en la UI)
-- ---------------------------------------------------------------------

drop view if exists public.vw_producto_almacen cascade;

create view public.vw_producto_almacen
with (security_invoker = true) as
select
  pa.id,
  pa.producto_id,
  pa.almacen_id,
  pa.estado_id,
  pa.ubicacion,
  pa.stock_actual,
  pa.activo,
  pa.es_activo_fijo,
  pa.created_at,
  pa.updated_at,
  p.nombre         as producto_nombre,
  p.no_parte       as no_parte,
  p.no_serie       as no_serie,
  p.modelo         as modelo,
  p.marca          as marca,
  p.codigo_interno as codigo_interno,
  p.codigo_barras  as codigo_barras,
  a.nombre         as almacen_nombre,
  e.nombre         as estado_nombre
from public.producto_almacen pa
join public.productos p on p.id = pa.producto_id
join public.almacenes a on a.id = pa.almacen_id
left join public.estados e on e.id = pa.estado_id
where pa.activo = true;

grant select on public.vw_producto_almacen to authenticated;
