-- 0042 — Código de control por existencia (N.º de orden de trabajo / código del proveedor)
--
-- Cuando un insumo o componente vuelve de una reparación, el proveedor le asigna un código
-- (N.º de OT, código del proveedor). Ese código se teclea al registrar la ENTRADA y queda
-- pegado a la existencia concreta en `producto_almacen`. Pasa a formar parte de la identidad
-- de la existencia: dos entradas del mismo n.º de parte con distinto código de control NO se
-- fusionan ni se suman. Las existencias sin código de control se comportan igual que antes.
--
-- El grano de existencia pasa de
--   (producto_id, almacen_id, estado_id, ubicacion_norm)
-- a
--   (producto_id, almacen_id, estado_id, ubicacion_norm, codigo_control_norm).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Columna + normalización + grano
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.producto_almacen
  add column if not exists codigo_control varchar;

-- Espejo normalizado, como `ubicacion_norm` (0005): sirve de clave de identidad y de
-- comparación insensible a mayúsculas/espacios.
alter table public.producto_almacen
  add column if not exists codigo_control_norm text
  generated always as (nullif(upper(btrim(codigo_control::text)), '')) stored;

drop index if exists public.uq_producto_almacen_grano;
create unique index uq_producto_almacen_grano
  on public.producto_almacen (producto_id, almacen_id, estado_id, ubicacion_norm, codigo_control_norm)
  nulls not distinct
  where activo;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. registrar_movimiento — el código de control viaja por renglón (p_items[].codigo_control)
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

    -- Consumible agotado con ubicación: se une al hueco "sin ubicación" del MISMO lote
    -- (mismo código de control), o suelta la ubicación.
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

    -- Si otro renglón del MISMO lote (mismo código de control) tiene stock, se desactivan
    -- las existencias vacías de ese lote para que no queden fantasmas.
    if not v_traz and exists (
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
-- 3. cambiar_estado_existencia — nunca fusiona lotes con distinto código de control
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.cambiar_estado_existencia(
  p_producto_almacen_id bigint, p_estado_id bigint, p_ubicacion character varying)
 returns producto_almacen
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
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

  -- Un artículo trazable ocupa una sola existencia: no hay nada que fusionar.
  if v_pa.es_trazable then
    update public.producto_almacen
       set estado_id = p_estado_id, ubicacion = v_ubic, updated_at = now()
     where id = v_pa.id
    returning * into v_pa;
    return v_pa;
  end if;

  -- ¿Ya existe otra existencia con ese estado, esa ubicación y el MISMO código de control?
  select * into v_destino
    from public.producto_almacen
   where producto_id = v_pa.producto_id
     and almacen_id  = v_pa.almacen_id
     and activo
     and id <> v_pa.id
     and estado_id is not distinct from p_estado_id
     and ubicacion_norm is not distinct from nullif(upper(btrim(coalesce(v_ubic, ''))), '')
     and codigo_control_norm is not distinct from v_pa.codigo_control_norm
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
end $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. registrar_transferencia — el código de control del origen viaja al destino
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.registrar_transferencia(
  p_almacen_origen_id bigint, p_almacen_destino_id bigint, p_fecha date,
  p_motivo character varying, p_observaciones text, p_usuario_id bigint, p_items jsonb)
 returns transferencias
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_t           public.transferencias;
  v_item        jsonb;
  v_pa_o_id     bigint;
  v_producto_id bigint;
  v_cantidad    numeric;
  v_ubic_dest   varchar;
  v_pa_o        public.producto_almacen;
  v_pa_d        public.producto_almacen;
  v_estado_id   bigint;
  v_nombre      text;
  v_traz        boolean;
  v_nuevo_o     numeric;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La transferencia no tiene productos.';
  end if;

  if p_almacen_origen_id is null or p_almacen_destino_id is null then
    raise exception 'Falta el almacén de origen o el de destino.';
  end if;

  if p_almacen_origen_id = p_almacen_destino_id then
    raise exception 'El almacén de origen y el de destino deben ser distintos.';
  end if;

  insert into public.transferencias
    (almacen_origen_id, almacen_destino_id, fecha, motivo, observaciones, usuario_id)
  values
    (p_almacen_origen_id, p_almacen_destino_id, coalesce(p_fecha, current_date),
     p_motivo, p_observaciones, p_usuario_id)
  returning * into v_t;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_pa_o_id     := nullif(v_item ->> 'producto_almacen_id_origen', '')::bigint;
    v_producto_id := (v_item ->> 'producto_id')::bigint;
    v_cantidad    := (v_item ->> 'cantidad')::numeric;
    v_ubic_dest   := nullif(btrim(coalesce(v_item ->> 'ubicacion_destino', '')), '');

    if v_cantidad is null or v_cantidad <= 0 then
      raise exception 'La cantidad debe ser mayor que cero.';
    end if;

    if v_pa_o_id is null then
      raise exception 'Falta la existencia de origen en un renglón.';
    end if;

    select * into v_pa_o from public.producto_almacen where id = v_pa_o_id;
    if not found or not v_pa_o.activo then
      raise exception 'La existencia de origen indicada no existe o está inactiva.';
    end if;
    if v_pa_o.almacen_id <> p_almacen_origen_id then
      raise exception 'La existencia de origen no pertenece al almacén de origen.';
    end if;
    if v_producto_id is not null and v_pa_o.producto_id <> v_producto_id then
      raise exception 'La existencia de origen no corresponde al producto indicado.';
    end if;
    v_producto_id := v_pa_o.producto_id;

    select nombre, coalesce(es_trazable, false)
      into v_nombre, v_traz
      from public.productos
     where id = v_producto_id;

    v_estado_id := v_pa_o.estado_id;
    v_ubic_dest := coalesce(v_ubic_dest, v_pa_o.ubicacion);

    if v_traz then
      if v_cantidad <> coalesce(v_pa_o.stock_actual, 0) then
        raise exception
          'El componente trazable "%" se transfiere completo (stock %); no admite cantidades parciales.',
          coalesce(v_nombre, v_producto_id::text), coalesce(v_pa_o.stock_actual, 0);
      end if;

      update public.producto_almacen
         set almacen_id = p_almacen_destino_id,
             ubicacion  = v_ubic_dest,
             updated_at = now()
       where id = v_pa_o.id
      returning * into v_pa_d;

    else
      v_nuevo_o := coalesce(v_pa_o.stock_actual, 0) - v_cantidad;
      if v_nuevo_o < 0 then
        raise exception
          'Stock insuficiente para "%": disponible %, solicitado %.',
          coalesce(v_nombre, v_producto_id::text), coalesce(v_pa_o.stock_actual, 0), v_cantidad;
      end if;

      update public.producto_almacen
         set stock_actual = v_nuevo_o, updated_at = now()
       where id = v_pa_o.id;

      if v_nuevo_o = 0 then
        update public.producto_almacen
           set activo = false, updated_at = now()
         where id = v_pa_o.id;
      end if;

      select * into v_pa_d
        from public.producto_almacen
       where producto_id = v_producto_id
         and almacen_id  = p_almacen_destino_id
         and activo
         and estado_id is not distinct from v_estado_id
         and ubicacion_norm is not distinct from nullif(upper(btrim(coalesce(v_ubic_dest, ''))), '')
         and codigo_control_norm is not distinct from v_pa_o.codigo_control_norm
       limit 1;

      if found then
        update public.producto_almacen
           set stock_actual = coalesce(stock_actual, 0) + v_cantidad,
               activo = true, updated_at = now()
         where id = v_pa_d.id
        returning * into v_pa_d;
      else
        insert into public.producto_almacen
          (producto_id, almacen_id, stock_actual, estado_id, ubicacion, codigo_control)
        values
          (v_producto_id, p_almacen_destino_id, v_cantidad, v_estado_id, v_ubic_dest, v_pa_o.codigo_control)
        returning * into v_pa_d;
      end if;
    end if;

    insert into public.transferencia_detalle
      (transferencia_id, producto_id, cantidad, estado_id,
       ubicacion_origen, ubicacion_destino,
       producto_almacen_id_origen, producto_almacen_id_destino)
    values
      (v_t.id, v_producto_id, v_cantidad, v_estado_id,
       v_pa_o.ubicacion, v_ubic_dest,
       v_pa_o.id, v_pa_d.id);
  end loop;

  return v_t;
end $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Vistas
-- ─────────────────────────────────────────────────────────────────────────────

-- 5a. vw_producto_almacen: expone el código de control de cada existencia.
create or replace view public.vw_producto_almacen
with (security_invoker = true) as
 select pa.id,
    pa.producto_id,
    pa.almacen_id,
    pa.estado_id,
    pa.ubicacion,
    pa.stock_actual,
    pa.activo,
    pa.es_trazable,
    pa.created_at,
    pa.updated_at,
    p.nombre as producto_nombre,
    p.no_parte,
    p.marca,
    p.codigo_barras,
    a.nombre as almacen_nombre,
    e.nombre as estado_nombre,
    u.series as no_serie,
    pa.codigo_control,
    pa.codigo_control_norm
   from producto_almacen pa
     join productos p on p.id = pa.producto_id
     join almacenes a on a.id = pa.almacen_id
     left join estados e on e.id = pa.estado_id
     left join lateral ( select string_agg(btrim(pu.no_serie::text), ', '::text order by (btrim(pu.no_serie::text))) as series
           from producto_unidad pu
          where pu.producto_id = pa.producto_id and pu.activo and pu.no_serie is not null and btrim(pu.no_serie::text) <> ''::text) u on true
  where pa.activo = true;

-- 5b. vw_stock_agrupado: el grano de agrupación pasa a incluir ubicación, estado y código
-- de control. Se suma el stock solo dentro de (n.º parte + ubicación + estado + código de
-- control); cada código de control aparece en su propia fila.
drop view if exists public.vw_stock_agrupado;
create view public.vw_stock_agrupado
with (security_invoker = true) as
 select pa.almacen_id,
    a.nombre as almacen_nombre,
    p.no_parte,
    min(p.nombre::text) as producto_nombre,
    pa.ubicacion_norm,
    min(pa.ubicacion::text) as ubicacion,
    pa.estado_id,
    e.nombre as estado_nombre,
    pa.codigo_control_norm,
    min(pa.codigo_control::text) as codigo_control,
    sum(pa.stock_actual) as stock_total,
    count(distinct pa.producto_id) as total_series,
    count(*) as total_existencias,
    min(p.marca::text) as marca,
    bool_or(pa.es_trazable) as es_trazable
   from producto_almacen pa
     join productos p on p.id = pa.producto_id
     join almacenes a on a.id = pa.almacen_id
     left join estados e on e.id = pa.estado_id
  where pa.activo = true
  group by pa.almacen_id, a.nombre, p.no_parte,
    (coalesce(nullif(btrim(p.no_parte::text), ''::text), 'prod:'::text || pa.producto_id::text)),
    pa.ubicacion_norm, pa.estado_id, e.nombre, pa.codigo_control_norm;

grant select on public.vw_stock_agrupado to authenticated;

-- 5c. vw_productos_trazables: el código de control de la existencia del componente.
create or replace view public.vw_productos_trazables
with (security_invoker = true) as
 select p.id,
    p.nombre,
    p.no_parte,
    p.marca,
    p.codigo_erp,
    p.descripcion,
    p.equipos_compatible,
    p.unidad_medida_id,
    p.codigo_barras,
    p.es_trazable,
    p.activo,
    p.created_at,
    p.updated_at,
    u.no_serie,
    u.codigo_interno,
    u.modelo,
    pae.estado_id,
    e.nombre as estado_nombre,
    coalesce(n.total, 0) as unidades,
    pae.id as producto_almacen_id,
    pae.ubicacion,
    pae.almacen_id,
    a.nombre as almacen_nombre,
    sal.unidad_operativa_nombre as salida_unidad_operativa,
    sal.equipo_etiqueta as salida_equipo,
    pae.codigo_control
   from productos p
     left join lateral ( select pu.no_serie, pu.codigo_interno, pu.modelo
           from producto_unidad pu
          where pu.producto_id = p.id and pu.activo
          order by pu.id
         limit 1) u on true
     left join lateral ( select pa.id, pa.estado_id, pa.ubicacion, pa.almacen_id, pa.codigo_control
           from producto_almacen pa
          where pa.producto_id = p.id and pa.activo
          order by pa.id
         limit 1) pae on true
     left join estados e on e.id = pae.estado_id
     left join almacenes a on a.id = pae.almacen_id
     left join lateral ( select count(*)::integer as total
           from producto_unidad pu2
          where pu2.producto_id = p.id and pu2.activo) n on true
     left join lateral ( select uo.nombre as unidad_operativa_nombre,
            concat_ws('/'::text, nullif(btrim(eq.modelo::text), ''::text), nullif(btrim(eq.no_serie::text), ''::text), nullif(btrim(vae.codigo_asignado::text), ''::text)) as equipo_etiqueta
           from movimiento_detalle md
             join movimientos m on m.id = md.movimiento_id
             left join unidad_operativa uo on uo.id = m.id_unidad_operativa
             left join equipos eq on eq.id = m.id_equipo
             left join lateral ( select a2.codigo_asignado
                   from equipo_unidad_operativa a2
                  where a2.equipo_id = m.id_equipo and a2.activo and a2.fecha_fin is null
                  order by a2.fecha_inicio desc, a2.id desc
                 limit 1) vae on true
          where md.producto_id = p.id and m.tipo_movimiento::text = 'salida'::text and (m.id_unidad_operativa is not null or m.id_equipo is not null)
          order by m.fecha desc, m.id desc
         limit 1) sal on true;
