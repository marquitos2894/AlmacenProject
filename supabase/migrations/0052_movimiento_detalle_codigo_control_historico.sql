-- =====================================================================
-- 0052 — El código de control queda grabado en el renglón del movimiento,
-- no se lee en vivo de la existencia.
--
-- `movimiento_detalle` ya guarda `estado_id` y `ubicacion` como una FOTO del
-- momento del movimiento (no como un join en vivo a `producto_almacen`),
-- justamente porque esos datos cambian con el tiempo y el historial no debe
-- moverse con ellos. El código de control (0042) se había quedado fuera de
-- ese patrón: la vista lo leía en vivo desde `producto_almacen.codigo_control`
-- (0049). Como 0050 borra ese campo en cuanto la existencia se agota, un
-- movimiento antiguo que sí usó un código de control lo "perdía" en cuanto
-- esa existencia llegaba a stock 0 — el historial cambiaba solo, sin que
-- nadie tocara ese movimiento.
--
-- Ahora `movimiento_detalle.codigo_control` guarda su propio valor, grabado
-- al momento de registrar el movimiento, igual que `ubicacion`.
-- =====================================================================

alter table public.movimiento_detalle
  add column if not exists codigo_control varchar;

-- Backfill: la mejor aproximación posible para movimientos ya existentes es
-- el código de control que tiene HOY la existencia que referencian (no hay
-- forma de recuperar el valor exacto de ese instante si ya cambió).
update public.movimiento_detalle md
   set codigo_control = pa.codigo_control
  from public.producto_almacen pa
 where pa.id = md.producto_almacen_id
   and md.codigo_control is null
   and pa.codigo_control is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- registrar_movimiento: graba el código de control resuelto para cada
-- renglón (v_pa.codigo_control, ya calculado antes de este insert) en vez de
-- dejar que la vista lo lea después desde producto_almacen.
-- ─────────────────────────────────────────────────────────────────────────────

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

    -- El código de control se graba tal cual queda resuelto en v_pa en este
    -- instante: es una foto, igual que ubicacion/estado_id. No cambia después
    -- aunque la existencia se agote y su propio código se borre (0050).
    insert into public.movimiento_detalle
      (movimiento_id, producto_id, cantidad, estado_id, ubicacion, producto_almacen_id, codigo_control)
    values
      (v_mov.id, v_producto_id, v_cantidad, v_pa.estado_id, v_pa.ubicacion, v_pa.id, v_pa.codigo_control);

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
    -- (se desactiva y se borra el código de control), trazable o no. Esto
    -- afecta solo a producto_almacen; el renglón de movimiento_detalle ya
    -- grabó su propia copia arriba y no se toca.
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

-- ─────────────────────────────────────────────────────────────────────────────
-- vw_movimiento_detalle: el código de control sale de md.codigo_control (la
-- foto propia del renglón), ya no de un join en vivo a producto_almacen.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace view public.vw_movimiento_detalle
with (security_invoker = true) as
select md.id,
       md.movimiento_id,
       md.producto_id,
       md.producto_almacen_id,
       md.cantidad,
       md.estado_id,
       md.ubicacion,
       e.nombre as estado_nombre,
       m.folio,
       m.fecha,
       m.tipo_movimiento,
       m.almacen_id,
       p.nombre as producto_nombre,
       p.no_parte,
       p.codigo_barras,
       u.series as no_serie,
       m.es_stock_inicial,
       m.motivo,
       m.created_at,
       coalesce(p.es_trazable, false) as es_trazable,
       u.codigos_internos as codigo_interno,
       md.codigo_control
  from public.movimiento_detalle md
  join public.movimientos m on m.id = md.movimiento_id
  join public.productos p on p.id = md.producto_id
  left join public.estados e on e.id = md.estado_id
  left join lateral (
    select string_agg(s.no_serie, ', '::text order by s.no_serie)             as series,
           string_agg(s.codigo_interno, ', '::text order by s.codigo_interno) as codigos_internos
      from (
        select nullif(btrim(pu.no_serie::text), '')       as no_serie,
               nullif(btrim(pu.codigo_interno::text), '')  as codigo_interno
          from public.producto_unidad pu
         where pu.producto_id = md.producto_id
           and pu.activo
      ) s
  ) u on true;

grant select on public.vw_movimiento_detalle to authenticated;
