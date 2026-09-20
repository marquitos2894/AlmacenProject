-- =====================================================================
-- 0050 — Una existencia con código de control se cierra al agotarse.
--
-- El código de control (0042) identifica un lote/orden de trabajo concreto.
-- Hasta ahora, cuando una salida dejaba en 0 una existencia CON código de
-- control: los componentes (trazables) sí se desactivaban (ya lo hacía la
-- lógica general), pero los consumibles con código de control podían quedar
-- activos con stock 0 (solo se limpiaba la ubicación) si no había otra
-- existencia del mismo lote con la que fusionarse, y en ningún caso se
-- borraba el propio código de control.
--
-- Ahora, sea trazable o no, en cuanto una existencia CON código de control
-- llega a 0: se desactiva (desaparece de "Stock por almacén") y se le borra
-- el código de control — el lote se da por cerrado, no queda disponible para
-- que una futura entrada lo reutilice sin querer. Las existencias SIN código
-- de control no cambian su comportamiento (siguen las reglas de 0030/0032).
-- =====================================================================

create or replace function public.registrar_movimiento(
  p_almacen_id bigint, p_fecha date, p_tipo_movimiento character varying,
  p_es_stock_inicial boolean, p_motivo character varying, p_observaciones text,
  p_usuario_id bigint, p_items jsonb,
  p_id_producto_unidad bigint default null::bigint, p_id_equipo bigint default null::bigint,
  p_id_unidad_operativa bigint default null::bigint, p_id_proveedor bigint default null::bigint)
 returns movimientos
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_mov           public.movimientos;
  v_item          jsonb;
  v_producto_id   bigint;
  v_cantidad      numeric;
  v_estado_id     bigint;
  v_ubicacion     varchar;
  v_codigo_control varchar;
  v_pa_id         bigint;
  v_pa            public.producto_almacen;
  v_nuevo         numeric;
  v_nombre        text;
  v_traz          boolean;
  v_otro          text;
  v_existente     numeric;
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
    v_producto_id    := (v_item ->> 'producto_id')::bigint;
    v_cantidad       := (v_item ->> 'cantidad')::numeric;
    v_estado_id      := nullif(v_item ->> 'estado_id', '')::bigint;
    v_ubicacion      := nullif(btrim(coalesce(v_item ->> 'ubicacion', '')), '');
    v_codigo_control := nullif(btrim(coalesce(v_item ->> 'codigo_control', '')), '');
    v_pa_id          := nullif(v_item ->> 'producto_almacen_id', '')::bigint;

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
               codigo_control = coalesce(v_codigo_control, codigo_control),
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
         and codigo_control_norm is not distinct from nullif(upper(btrim(coalesce(v_codigo_control, ''))), '')
       limit 1;
    end if;

    if v_pa.id is null then
      insert into public.producto_almacen (producto_id, almacen_id, stock_actual, estado_id, ubicacion, codigo_control)
      values (v_producto_id, p_almacen_id, 0, v_estado_id, v_ubicacion, v_codigo_control)
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

    -- Existencia CON código de control que se agota: se cierra el lote
    -- (se desactiva y se borra el código de control), trazable o no.
    if v_pa.codigo_control is not null and v_nuevo = 0 then
      update public.producto_almacen
         set activo = false, codigo_control = null, updated_at = now()
       where id = v_pa.id;
    end if;

    -- Consumible SIN código de control que se agota suelta su ubicación (o se
    -- desactiva si chocara con otra existencia vacía sin ubicación).
    if not v_traz
       and v_pa.codigo_control is null
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
           and pa2.codigo_control_norm is not distinct from v_pa.codigo_control_norm
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

    -- Consolidación de existencias vacías SIN código de control del mismo
    -- producto/almacén: si otro renglón sin código de control tiene stock,
    -- se desactivan las que quedaron en cero.
    if not v_traz and v_pa.codigo_control is null and exists (
      select 1
        from public.producto_almacen o
       where o.producto_id = v_producto_id
         and o.almacen_id  = p_almacen_id
         and o.activo
         and o.codigo_control_norm is not distinct from v_pa.codigo_control_norm
         and coalesce(o.stock_actual, 0) > 0
    ) then
      update public.producto_almacen z
         set activo = false, updated_at = now()
       where z.producto_id = v_producto_id
         and z.almacen_id  = p_almacen_id
         and z.activo
         and z.codigo_control_norm is not distinct from v_pa.codigo_control_norm
         and coalesce(z.stock_actual, 0) = 0;
    end if;
  end loop;

  return v_mov;
end $function$;

-- --------------------------------------------------------------- Backfill
-- Existencias ya en 0 con un código de control que quedaron activas: se
-- cierran igual que lo haría ahora una salida nueva.
update public.producto_almacen
   set activo = false, codigo_control = null, updated_at = now()
 where activo
   and codigo_control is not null
   and coalesce(stock_actual, 0) = 0;
