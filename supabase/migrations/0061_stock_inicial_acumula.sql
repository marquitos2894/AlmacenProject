-- =====================================================================
-- 0061 — El Stock Inicial ya no reemplaza el stock: se acumula.
--
-- Problema (caso real, CILINDRO GATA 77019096): una existencia con 3 unidades
-- recibió un "Stock Inicial" de 1 y quedó en 1. `registrar_movimiento`
-- sobrescribía `stock_actual` con la cantidad capturada, así que un Stock
-- Inicial registrado DESPUÉS de otras entradas borraba esas unidades sin
-- dejar rastro (el historial seguía sumando 5, el stock decía 1).
--
-- Decisión: un renglón de Stock Inicial SUMA a la existencia, igual que una
-- entrada. Si la existencia es nueva o está en cero, el resultado es el mismo
-- de antes (queda en la cantidad capturada); lo único que desaparece es la
-- posibilidad de pisar stock que ya existía. La marca `es_stock_inicial` se
-- conserva como etiqueta del ticket (y para permitir cargar trazables ya
-- existentes sin la regla de "solo salidas").
--
-- anular_movimiento: un Stock Inicial se revierte igual que una entrada
-- (resta su cantidad, sin dejar el stock en negativo). Se conserva el
-- comportamiento anterior (existencia a 0 y desactivada) solo cuando ese
-- renglón es lo único que la creó: no hay otros movimientos y su stock no
-- supera la cantidad del renglón.
--
-- Los Stock Inicial ya registrados no se tocan: sus efectos quedaron como
-- estaban. Idempotente (create or replace).
-- =====================================================================

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

create or replace function public.anular_movimiento(p_movimiento_id bigint, p_motivo text default null::text)
 returns void
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_mov        public.movimientos;
  v_usuario_id bigint;
  v_det        record;
  v_pa         public.producto_almacen;
  v_otros      int;
  v_nuevo      numeric;
begin
  if not public.puede_editar() then
    raise exception 'No tienes permiso para editar.';
  end if;

  select * into v_mov from public.movimientos where id = p_movimiento_id for update;
  if not found then
    raise exception 'El movimiento no existe.';
  end if;
  if v_mov.anulado then
    raise exception 'Ese movimiento ya está anulado.';
  end if;

  select u.id into v_usuario_id from public.usuarios u where u.auth_uid = auth.uid();

  for v_det in
    select md.* from public.movimiento_detalle md where md.movimiento_id = p_movimiento_id
  loop
    if v_det.producto_almacen_id is null then
      raise exception 'No se puede anular: un renglón no tiene existencia asociada (movimiento anterior a ese registro).';
    end if;

    select * into v_pa from public.producto_almacen where id = v_det.producto_almacen_id for update;
    if not found then
      raise exception 'La existencia asociada a este movimiento ya no existe.';
    end if;

    select count(*) into v_otros
      from public.movimiento_detalle md2
     where md2.producto_almacen_id = v_pa.id and md2.id <> v_det.id;

    if v_mov.es_stock_inicial and v_otros = 0 and coalesce(v_pa.stock_actual, 0) <= v_det.cantidad then
      -- Este renglón es lo único que creó la existencia: se cierra.
      update public.producto_almacen
         set stock_actual = 0, activo = false, codigo_control = null, updated_at = now()
       where id = v_pa.id;
    else
      -- Un Stock Inicial acumula como una entrada, así que se revierte igual.
      if v_mov.tipo_movimiento = 'salida' and not v_mov.es_stock_inicial then
        v_nuevo := coalesce(v_pa.stock_actual, 0) + v_det.cantidad;
      else
        v_nuevo := coalesce(v_pa.stock_actual, 0) - v_det.cantidad;
      end if;

      if v_nuevo < 0 then
        raise exception 'No se puede anular: dejaría el stock en negativo (hay movimientos posteriores que ya lo consumieron).';
      end if;

      begin
        update public.producto_almacen
           set stock_actual = v_nuevo,
               activo = case
                 when v_pa.es_trazable or v_det.codigo_control is not null then v_nuevo > 0
                 else activo
               end,
               codigo_control = coalesce(codigo_control, case when v_nuevo > 0 then v_det.codigo_control else null end),
               updated_at = now()
         where id = v_pa.id;
      exception when unique_violation then
        raise exception 'No se puede anular: reactivar esta existencia chocaría con otra existencia activa igual (mismo producto, almacén, estado, ubicación y código de control). Revísalo manualmente en Stock por almacén.';
      end;
    end if;
  end loop;

  update public.movimientos
     set anulado = true,
         anulado_en = now(),
         anulado_motivo = nullif(btrim(coalesce(p_motivo, '')), ''),
         anulado_por = v_usuario_id
   where id = p_movimiento_id;
end $function$;
