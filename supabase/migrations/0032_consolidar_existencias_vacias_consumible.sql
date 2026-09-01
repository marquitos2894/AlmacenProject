-- =====================================================================
-- 0032 — Consolidar existencias vacías de un consumible.
--
-- Si un consumible tiene varias existencias en un almacén y alguna está en 0,
-- esas existencias vacías no deben seguir figurando (fragmentan el stock que
-- se ve en "Stock por almacén"). Al procesar cada renglón de un movimiento,
-- si el producto tiene stock en alguna existencia de ese almacén, se
-- desactivan sus existencias vacías.
--
-- Se apoya en 0030 (un consumible que se agota suelta su ubicación) y en 0026
-- (un trazado que sale por completo se desactiva). Los trazables no se tocan
-- aquí. Idempotente.
-- =====================================================================

create or replace function public.registrar_movimiento(
  p_almacen_id bigint,
  p_fecha date,
  p_tipo_movimiento character varying,
  p_es_stock_inicial boolean,
  p_motivo character varying,
  p_observaciones text,
  p_usuario_id bigint,
  p_items jsonb,
  p_id_producto_unidad bigint default null::bigint,
  p_id_equipo bigint default null::bigint,
  p_id_unidad_operativa bigint default null::bigint,
  p_id_proveedor bigint default null::bigint
) returns public.movimientos
language plpgsql
set search_path to 'public', 'pg_temp'
as $fn$
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
    (almacen_id, fecha, tipo_movimiento, es_stock_inicial, motivo, observaciones,
     usuario_id, id_producto_unidad, id_equipo, id_unidad_operativa, id_proveedor)
  values
    (p_almacen_id, coalesce(p_fecha, current_date), p_tipo_movimiento,
     coalesce(p_es_stock_inicial, false), p_motivo, p_observaciones,
     p_usuario_id, p_id_producto_unidad, p_id_equipo, p_id_unidad_operativa, p_id_proveedor)
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
       set stock_actual = v_nuevo,
           activo = not (v_traz and v_nuevo = 0),
           updated_at = now()
     where id = v_pa.id;

    -- 0030: un consumible que se agota suelta su ubicación (o se desactiva si
    -- chocara con otra existencia vacía).
    if not v_traz
       and v_nuevo = 0
       and not coalesce(p_es_stock_inicial, false)
       and v_pa.ubicacion is not null then
      if exists (
        select 1
          from public.producto_almacen pa2
         where pa2.activo
           and pa2.id <> v_pa.id
           and pa2.producto_id = v_producto_id
           and pa2.almacen_id  = p_almacen_id
           and pa2.estado_id is not distinct from v_pa.estado_id
           and pa2.ubicacion_norm is null
      ) then
        update public.producto_almacen
           set activo = false, updated_at = now()
         where id = v_pa.id;
      else
        update public.producto_almacen
           set ubicacion = null, updated_at = now()
         where id = v_pa.id;
      end if;
    end if;

    -- 0032: consolidación. Si el consumible tiene stock en alguna existencia
    -- de este almacén, se desactivan todas sus existencias vacías.
    if not v_traz and exists (
      select 1
        from public.producto_almacen o
       where o.producto_id = v_producto_id
         and o.almacen_id  = p_almacen_id
         and o.activo
         and coalesce(o.stock_actual, 0) > 0
    ) then
      update public.producto_almacen z
         set activo = false, updated_at = now()
       where z.producto_id = v_producto_id
         and z.almacen_id  = p_almacen_id
         and z.activo
         and coalesce(z.stock_actual, 0) = 0;
    end if;
  end loop;

  return v_mov;
end $fn$;

grant execute on function public.registrar_movimiento(
  bigint, date, character varying, boolean, character varying, text, bigint, jsonb,
  bigint, bigint, bigint, bigint
) to authenticated;

-- --------------------------------------------------------------- Backfill
-- Consumibles con una existencia vacía y otra con stock en el mismo almacén:
-- se desactiva la vacía.
update public.producto_almacen z
   set activo = false, updated_at = now()
 where z.activo
   and z.es_trazable = false
   and coalesce(z.stock_actual, 0) = 0
   and exists (
     select 1
       from public.producto_almacen o
      where o.producto_id = z.producto_id
        and o.almacen_id  = z.almacen_id
        and o.activo
        and coalesce(o.stock_actual, 0) > 0
   );
