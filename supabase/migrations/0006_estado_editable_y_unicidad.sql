-- =====================================================================
-- 0006 — Cambios solicitados:
--   1. Cambiar estado/ubicación desde Stock por almacén, fusionando la
--      existencia si el destino ya existe (solo si NO es activo fijo).
--   2. Se elimina el costo unitario (y el subtotal derivado).
--   3. Un activo fijo con stock > 0 no admite entradas, solo salidas.
--      Con stock 0 vuelve a admitir una entrada.
--   7. no_serie único.
--   8. no_parte único SOLO para productos que no son activo fijo
--      (los activos fijos son unidades físicas que comparten número de
--       parte y se distinguen por su serie — confirmado con el usuario).
--
-- Idempotente: puede re-ejecutarse en el SQL Editor de Supabase.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Unicidad en productos
-- ---------------------------------------------------------------------

-- Una serie identifica una unidad física: no puede repetirse.
create unique index if not exists uq_productos_no_serie
  on public.productos (upper(btrim(no_serie)))
  where no_serie is not null and btrim(no_serie) <> '' and activo;

-- El número de parte identifica un artículo de catálogo. Los activos fijos
-- quedan fuera: varias máquinas del mismo modelo comparten no_parte.
create unique index if not exists uq_productos_no_parte_consumible
  on public.productos (upper(btrim(no_parte)))
  where no_parte is not null and btrim(no_parte) <> '' and activo and not activofijo;

-- ---------------------------------------------------------------------
-- 2. Fuera el costo unitario (subtotal se deriva de él, va primero)
-- ---------------------------------------------------------------------

drop view if exists public.vw_movimientos;
drop view if exists public.vw_movimiento_detalle;

alter table public.movimiento_detalle drop column if exists subtotal;
alter table public.movimiento_detalle drop column if exists costo_unitario;

-- ---------------------------------------------------------------------
-- 3. RPC de registro — sin costo y con la regla de activo fijo
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
  v_fijo        boolean;
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

    select nombre, coalesce(activofijo, false)
      into v_nombre, v_fijo
      from public.productos
     where id = v_producto_id;

    if v_nombre is null then
      raise exception 'El producto % no existe.', v_producto_id;
    end if;

    -- Regla 3: un activo fijo ya presente en el inventario no vuelve a entrar.
    -- Es una unidad física única; solo puede salir. Si su stock quedó en 0,
    -- vuelve a admitir una entrada.
    if v_fijo and p_tipo_movimiento <> 'salida' and not coalesce(p_es_stock_inicial, false) then
      select coalesce(sum(stock_actual), 0) into v_existente
        from public.producto_almacen
       where producto_id = v_producto_id and activo;

      if v_existente > 0 then
        raise exception
          'El activo fijo "%" ya está en inventario (stock %). Solo admite salidas; para reingresarlo, su stock debe quedar en cero.',
          coalesce(v_nombre, v_producto_id::text), v_existente;
      end if;
    end if;

    v_pa := null;

    -- Existencia indicada explícitamente (caso típico de una salida)
    if v_pa_id is not null then
      select * into v_pa from public.producto_almacen where id = v_pa_id;

      if not found then
        raise exception 'La existencia indicada no existe.';
      end if;
      if v_pa.producto_id <> v_producto_id or v_pa.almacen_id <> p_almacen_id then
        raise exception 'La existencia indicada no corresponde a "%" en este almacén.',
          coalesce(v_nombre, v_producto_id::text);
      end if;

    -- Activo fijo: unidad física única -> se traslada, no se duplica
    elsif v_fijo then
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

    -- Producto normal: la existencia se identifica por el grano completo
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
-- 4. Cambiar estado / ubicación de una existencia desde Stock por almacén
--    Si el destino ya existe, las dos existencias se FUSIONAN (se suman)
--    y la de origen se desactiva. Un activo fijo nunca fusiona: solo tiene
--    una fila, así que se actualiza en su lugar.
-- ---------------------------------------------------------------------

create or replace function public.cambiar_estado_existencia(
  p_producto_almacen_id bigint,
  p_estado_id           bigint,
  p_ubicacion           varchar
)
returns public.producto_almacen
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_pa      public.producto_almacen;
  v_destino public.producto_almacen;
  v_ubic    varchar;
begin
  select * into v_pa from public.producto_almacen where id = p_producto_almacen_id;
  if not found then
    raise exception 'La existencia indicada no existe.';
  end if;
  if not v_pa.activo then
    raise exception 'Esa existencia está desactivada.';
  end if;

  v_ubic := nullif(btrim(coalesce(p_ubicacion, '')), '');

  -- Activo fijo: una sola fila, no hay nada que fusionar.
  if v_pa.es_activo_fijo then
    update public.producto_almacen
       set estado_id = p_estado_id, ubicacion = v_ubic, updated_at = now()
     where id = v_pa.id
    returning * into v_pa;
    return v_pa;
  end if;

  -- ¿Ya existe otra existencia con ese estado y esa ubicación? -> fusionar
  select * into v_destino
    from public.producto_almacen
   where producto_id = v_pa.producto_id
     and almacen_id  = v_pa.almacen_id
     and activo
     and id <> v_pa.id
     and estado_id is not distinct from p_estado_id
     and ubicacion_norm is not distinct from nullif(upper(btrim(coalesce(v_ubic, ''))), '')
   limit 1;

  if found then
    update public.producto_almacen
       set stock_actual = coalesce(v_destino.stock_actual, 0) + coalesce(v_pa.stock_actual, 0),
           updated_at = now()
     where id = v_destino.id
    returning * into v_destino;

    -- La de origen se desactiva (nunca se borra: el histórico la referencia)
    update public.producto_almacen
       set activo = false, updated_at = now()
     where id = v_pa.id;

    return v_destino;
  end if;

  update public.producto_almacen
     set estado_id = p_estado_id, ubicacion = v_ubic, updated_at = now()
   where id = v_pa.id
  returning * into v_pa;
  return v_pa;
end $$;

grant execute on function public.cambiar_estado_existencia(bigint, bigint, varchar) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Vistas sin costo ni importe
-- ---------------------------------------------------------------------

create view public.vw_movimientos
with (security_invoker = true) as
select
  m.id, m.folio, m.fecha, m.tipo_movimiento, m.es_stock_inicial, m.motivo,
  m.observaciones, m.almacen_id, a.nombre as almacen_nombre, m.usuario_id,
  trim(coalesce(u.nombre, '') || ' ' || coalesce(u.apellido, '')) as usuario_nombre,
  m.created_at, d.total_items, d.total_cantidad,
  d.productos_resumen, d.busq_no_parte, d.busq_nombre, d.busq_ubicacion, d.estado_ids
from public.movimientos m
join public.almacenes a on a.id = m.almacen_id
left join public.usuarios u on u.id = m.usuario_id
left join lateral (
  select
    count(*)                                             as total_items,
    coalesce(sum(md.cantidad), 0)                        as total_cantidad,
    string_agg(distinct p.nombre, ', ')                  as productos_resumen,
    string_agg(distinct coalesce(p.no_parte, ''), ' ')   as busq_no_parte,
    string_agg(distinct p.nombre, ' ')                   as busq_nombre,
    string_agg(distinct coalesce(md.ubicacion, ''), ' ') as busq_ubicacion,
    array_remove(array_agg(distinct md.estado_id), null) as estado_ids
  from public.movimiento_detalle md
  join public.productos p on p.id = md.producto_id
  where md.movimiento_id = m.id
) d on true;

create view public.vw_movimiento_detalle
with (security_invoker = true) as
select
  md.id, md.movimiento_id, md.producto_id, md.producto_almacen_id,
  md.cantidad, md.estado_id, md.ubicacion,
  e.nombre        as estado_nombre,
  m.folio, m.fecha, m.tipo_movimiento, m.almacen_id,
  p.nombre        as producto_nombre,
  p.no_parte      as no_parte,
  p.no_serie      as no_serie,
  p.codigo_barras as codigo_barras
from public.movimiento_detalle md
join public.movimientos m on m.id = md.movimiento_id
join public.productos p on p.id = md.producto_id
left join public.estados e on e.id = md.estado_id;

grant select on public.vw_movimientos        to authenticated;
grant select on public.vw_movimiento_detalle to authenticated;
