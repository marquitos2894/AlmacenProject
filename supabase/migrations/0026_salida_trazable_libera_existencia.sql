-- =====================================================================
-- 0026 — La salida total de un componente libera su existencia.
--
-- Al registrar una salida de un producto trazable (componente), la RPC sí
-- restaba `producto_almacen.stock_actual` (llegaba a 0), pero dejaba la
-- existencia con `activo = true`. Resultado: el componente seguía figurando
-- en su almacén, con estado y ubicación, como si la salida no hubiera surtido
-- efecto — `vw_productos_trazables` y `vw_producto_almacen` filtran por
-- `activo`, no por stock, y `productos.estado_actual` / `ubicacion_actual`
-- solo se recalculan cuando cambia `activo`.
--
-- Un componente es una pieza única: si sale por completo, abandona el
-- inventario. Ahora, cuando una salida deja su existencia en 0, se desactiva.
-- Así desaparece de las vistas, el trigger `trg_productos_sync_actual` limpia
-- sus columnas derivadas y un reingreso posterior crea una existencia nueva
-- (la guardia de reingreso suma stock sobre existencias activas = 0 -> ok).
--
-- Los consumibles no cambian: una existencia en 0 sigue activa.
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
           -- inventario: se desactiva su existencia para que deje de figurar
           -- en el almacén y sus columnas derivadas en `productos` se limpien.
           activo = not (v_traz and v_nuevo = 0),
           updated_at = now()
     where id = v_pa.id;
  end loop;

  return v_mov;
end $fn$;

grant execute on function public.registrar_movimiento(
  bigint, date, character varying, boolean, character varying, text, bigint, jsonb,
  bigint, bigint, bigint, bigint
) to authenticated;

-- Corrección de datos: componentes que ya salieron por completo pero quedaron
-- con la existencia activa (comportamiento anterior). Al desactivarlas, el
-- trigger trg_productos_sync_actual limpia productos.estado_actual /
-- ubicacion_actual.
update public.producto_almacen
   set activo = false, updated_at = now()
 where es_trazable and activo and coalesce(stock_actual, 0) = 0;
