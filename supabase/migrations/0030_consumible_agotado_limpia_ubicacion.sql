-- =====================================================================
-- 0030 — Un consumible agotado pierde su ubicación actual.
--
-- Cuando una salida deja en 0 la existencia de un producto NO trazable
-- (consumible), la existencia sigue activa (stock 0 es un estado válido),
-- pero conservaba la última ubicación — una ubicación obsoleta para algo que
-- ya no está. Ahora se limpia (`ubicacion = null`).
--
-- Si al limpiarla chocara con otra existencia vacía del mismo producto /
-- almacén / estado (índice único `uq_producto_almacen_grano`, NULLS NOT
-- DISTINCT), se desactiva la existencia que quedó en cero: esa "ranura vacía"
-- ya existe.
--
-- Los trazables no cambian: su existencia en 0 se desactiva por completo
-- (migración 0026).
-- Idempotente.
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
           -- Un componente (trazable) que sale por completo abandona el
           -- inventario: se desactiva su existencia.
           activo = not (v_traz and v_nuevo = 0),
           updated_at = now()
     where id = v_pa.id;

    -- Un consumible que se agota suelta su ubicación (la existencia vacía no
    -- debe arrastrar una ubicación obsoleta). Si limpiarla chocara con otra
    -- existencia vacía del mismo producto/almacén/estado, se desactiva la que
    -- quedó en cero.
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
  end loop;

  return v_mov;
end $fn$;

grant execute on function public.registrar_movimiento(
  bigint, date, character varying, boolean, character varying, text, bigint, jsonb,
  bigint, bigint, bigint, bigint
) to authenticated;

-- --------------------------------------------------------------- Backfill
-- Consumibles ya agotados que conservan una ubicación obsoleta. Primero se
-- desactivan los que chocarían con otra existencia vacía (o con otro cero
-- ubicado de menor id, para no colisionar entre ellos); luego se limpia el
-- resto.
update public.producto_almacen pa
   set activo = false, updated_at = now()
 where pa.activo
   and pa.es_trazable = false
   and coalesce(pa.stock_actual, 0) = 0
   and pa.ubicacion is not null
   and exists (
     select 1
       from public.producto_almacen pa2
      where pa2.activo
        and pa2.id <> pa.id
        and pa2.producto_id = pa.producto_id
        and pa2.almacen_id  = pa.almacen_id
        and pa2.estado_id is not distinct from pa.estado_id
        and (
          pa2.ubicacion_norm is null
          or (coalesce(pa2.stock_actual, 0) = 0 and pa2.ubicacion is not null and pa2.id < pa.id)
        )
   );

update public.producto_almacen pa
   set ubicacion = null, updated_at = now()
 where pa.activo
   and pa.es_trazable = false
   and coalesce(pa.stock_actual, 0) = 0
   and pa.ubicacion is not null;
