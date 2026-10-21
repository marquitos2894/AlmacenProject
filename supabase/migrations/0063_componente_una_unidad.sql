-- =====================================================================
-- 0063 — Un componente es una unidad: nunca más de 1 en stock.
--
-- Problema (caso 55151490 y otros 5): un Stock Inicial de cantidad 2 dejó
-- componentes con stock 2 y un solo código interno, porque nada impedía mover
-- un componente de a varias unidades. Cada código interno identifica UNA pieza.
-- (Las 6 piezas sobrantes se separaron en productos propios con su código.)
--
-- Defensa en dos capas:
--  1) `registrar_movimiento` rechaza, con un mensaje claro, un renglón de
--     componente con cantidad distinta de 1 y cualquier movimiento que deje el
--     stock de un componente por encima de 1 (p. ej. un Stock Inicial sobre una
--     existencia que ya tiene la pieza).
--  2) CHECK en `producto_almacen`: ninguna otra vía (anulaciones, reclasificar,
--     SQL directo) puede dejar un componente con más de 1. `es_trazable` de la
--     existencia lo mantiene sincronizado un trigger (fn_pa_sync_trazable).
--
-- El resto de `registrar_movimiento` es idéntico a la 0061. Idempotente.
-- =====================================================================

alter table public.producto_almacen
  drop constraint if exists ck_producto_almacen_trazable_una_unidad;
alter table public.producto_almacen
  add constraint ck_producto_almacen_trazable_una_unidad
  check (not coalesce(es_trazable, false) or coalesce(stock_actual, 0) <= 1);

create or replace function public.registrar_movimiento(
  p_almacen_id bigint, p_fecha date, p_tipo_movimiento character varying,
  p_es_stock_inicial boolean, p_motivo character varying, p_observaciones text,
  p_usuario_id bigint, p_items jsonb,
  p_id_producto_unidad bigint default null::bigint,
  p_id_equipo bigint default null::bigint,
  p_id_unidad_operativa bigint default null::bigint,
  p_id_proveedor bigint default null::bigint)
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

    -- Un componente es una unidad física única (una pieza = un código interno):
    -- no se mueve de a varias. Otra pieza igual se da de alta como producto propio.
    if v_traz and v_cantidad <> 1 then
      raise exception
        'El componente "%" es una unidad física única: la cantidad debe ser 1 (se indicó %). Si hay otra pieza igual, regístrala como un componente nuevo con su propio código interno.',
        coalesce(v_nombre, v_producto_id::text), v_cantidad;
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
      (movimiento_id, producto_id, cantidad, estado_id, ubicacion, producto_almacen_id, codigo_control)
    values
      (v_mov.id, v_producto_id, v_cantidad, v_pa.estado_id, v_pa.ubicacion, v_pa.id, v_pa.codigo_control);

    -- Stock Inicial = entrada: acumula, nunca pisa el stock existente.
    if p_tipo_movimiento = 'salida' and not coalesce(p_es_stock_inicial, false) then
      v_nuevo := coalesce(v_pa.stock_actual, 0) - v_cantidad;
    else
      v_nuevo := coalesce(v_pa.stock_actual, 0) + v_cantidad;
    end if;

    if v_traz and v_nuevo > 1 then
      raise exception
        'El componente "%" ya está en stock: una unidad física única no puede tener más de 1. Si hay otra pieza igual, regístrala como un componente nuevo con su propio código interno.',
        coalesce(v_nombre, v_producto_id::text);
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

    if v_pa.codigo_control is not null and v_nuevo = 0 then
      update public.producto_almacen
         set activo = false, codigo_control = null, updated_at = now()
       where id = v_pa.id;
    end if;

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
