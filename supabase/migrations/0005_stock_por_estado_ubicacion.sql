-- =====================================================================
-- 0005 — El stock se identifica por (producto, almacén, estado, ubicación)
--
-- Regla: al registrar un movimiento, si el estado o la ubicación difieren
-- de una existencia previa, NO se suma: se crea una existencia nueva.
--
-- Decisiones confirmadas con el usuario:
--   * Activo fijo: cambiar estado/ubicación TRASLADA la fila existente
--     (es una unidad física única). Moverlo a OTRO almacén sigue siendo
--     un error, tal como se definió en 0003.
--   * Estado y ubicación se capturan POR RENGLÓN del carrito.
--   * En salidas, el renglón identifica la existencia exacta
--     (producto_almacen_id) — sin descuentos automáticos.
--   * Stock Inicial sobrescribe SOLO la existencia exacta.
--
-- Idempotente: puede re-ejecutarse en el SQL Editor de Supabase.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Normalización de la ubicación
--    "A-7", "a-7" y "A-7 " deben ser la MISMA ubicación; sin esto el
--    almacén se fragmenta solo. La columna generada es la que se indexa;
--    `ubicacion` conserva el texto tal como lo escribió el usuario.
-- ---------------------------------------------------------------------

alter table public.producto_almacen
  add column if not exists ubicacion_norm text
  generated always as (nullif(upper(btrim(ubicacion)), '')) stored;

-- ---------------------------------------------------------------------
-- 2. Unicidad del nuevo grano
--    NULLS NOT DISTINCT (Postgres 15+) hace que dos filas con estado o
--    ubicación NULL choquen entre sí, que es justo lo que queremos: sin
--    esto, `where ubicacion = null` nunca casa y la RPC crearía una fila
--    nueva en cada movimiento.
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'uq_producto_almacen_grano'
  ) then
    create unique index uq_producto_almacen_grano
      on public.producto_almacen (producto_id, almacen_id, estado_id, ubicacion_norm)
      nulls not distinct
      where activo;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. Trazabilidad en el detalle del ticket
--    Sin esto el ticket no dice a qué existencia afectó, y estado_ids de
--    vw_movimientos tenía que adivinarlo con un join ambiguo.
-- ---------------------------------------------------------------------

alter table public.movimiento_detalle
  add column if not exists estado_id          bigint references public.estados(id),
  add column if not exists ubicacion          varchar,
  add column if not exists producto_almacen_id bigint references public.producto_almacen(id);

create index if not exists idx_mov_detalle_pa on public.movimiento_detalle (producto_almacen_id);

-- Backfill del histórico: se resuelve la existencia por (producto, almacén).
-- Con el grano nuevo puede haber varias candidatas, así que se toma la más
-- antigua (row_number) para que el resultado sea determinista.
update public.movimiento_detalle md
   set producto_almacen_id = sub.pa_id,
       estado_id           = sub.estado_id,
       ubicacion           = sub.ubicacion
  from (
    select md2.id as det_id,
           pa.id  as pa_id,
           pa.estado_id,
           pa.ubicacion,
           row_number() over (partition by md2.id order by pa.id) as rn
      from public.movimiento_detalle md2
      join public.movimientos m on m.id = md2.movimiento_id
      join public.producto_almacen pa on pa.producto_id = md2.producto_id
                                     and pa.almacen_id = m.almacen_id
     where md2.producto_almacen_id is null
  ) sub
 where sub.det_id = md.id and sub.rn = 1;

-- ---------------------------------------------------------------------
-- 4. RPC — resuelve la existencia por el grano completo
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
  v_costo       numeric;
  v_estado_id   bigint;
  v_ubicacion   varchar;
  v_pa_id       bigint;
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

    v_pa := null;

    -- ---------------------------------------------------------------
    -- 4.a Existencia indicada explícitamente (caso típico de una salida)
    -- ---------------------------------------------------------------
    if v_pa_id is not null then
      select * into v_pa from public.producto_almacen where id = v_pa_id;

      if not found then
        raise exception 'La existencia indicada no existe.';
      end if;
      if v_pa.producto_id <> v_producto_id or v_pa.almacen_id <> p_almacen_id then
        raise exception 'La existencia indicada no corresponde a "%" en este almacén.',
          coalesce(v_nombre, v_producto_id::text);
      end if;

    -- ---------------------------------------------------------------
    -- 4.b Activo fijo: una unidad física única -> se TRASLADA, no se duplica
    -- ---------------------------------------------------------------
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

      -- Dentro del mismo almacén: reubicar / recalificar la fila existente.
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

    -- ---------------------------------------------------------------
    -- 4.c Producto normal: la existencia se identifica por el grano completo.
    --     `is not distinct from` para que NULL case con NULL.
    -- ---------------------------------------------------------------
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

    -- Sin existencia previa que coincida -> se crea una nueva
    if v_pa.id is null then
      insert into public.producto_almacen (producto_id, almacen_id, stock_actual, estado_id, ubicacion)
      values (v_producto_id, p_almacen_id, 0, v_estado_id, v_ubicacion)
      returning * into v_pa;
    end if;

    insert into public.movimiento_detalle
      (movimiento_id, producto_id, cantidad, costo_unitario, estado_id, ubicacion, producto_almacen_id)
    values
      (v_mov.id, v_producto_id, v_cantidad, v_costo, v_pa.estado_id, v_pa.ubicacion, v_pa.id);

    if coalesce(p_es_stock_inicial, false) then
      v_nuevo := v_cantidad;                                   -- sobrescribe SOLO esta existencia
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
-- 5. Vistas
-- ---------------------------------------------------------------------

drop view if exists public.vw_movimientos;
drop view if exists public.vw_movimiento_detalle;
drop view if exists public.vw_stock_agrupado;

-- 5.1 Stock agrupado.
--     Ojo con el significado: ahora un mismo producto puede tener varias
--     existencias (estado/ubicación), así que se distinguen dos conteos:
--       total_series      = artículos físicos distintos (la serie va en el producto)
--       total_existencias = renglones de stock (splits por estado/ubicación)
create view public.vw_stock_agrupado
with (security_invoker = true) as
select
  pa.almacen_id,
  a.nombre                        as almacen_nombre,
  p.no_parte                      as no_parte,
  min(p.nombre)                   as producto_nombre,
  sum(pa.stock_actual)            as stock_total,
  count(distinct pa.producto_id)  as total_series,
  count(*)                        as total_existencias,
  count(distinct pa.ubicacion_norm) as total_ubicaciones,
  min(p.marca)                    as marca
from public.producto_almacen pa
join public.productos p on p.id = pa.producto_id
join public.almacenes a on a.id = pa.almacen_id
where pa.activo = true
group by pa.almacen_id, a.nombre, p.no_parte;

-- 5.2 Encabezados de movimiento. estado_ids ahora sale del propio detalle,
--     no de un join adivinado contra el stock actual.
create view public.vw_movimientos
with (security_invoker = true) as
select
  m.id, m.folio, m.fecha, m.tipo_movimiento, m.es_stock_inicial, m.motivo,
  m.observaciones, m.almacen_id, a.nombre as almacen_nombre, m.usuario_id,
  trim(coalesce(u.nombre, '') || ' ' || coalesce(u.apellido, '')) as usuario_nombre,
  m.created_at, d.total_items, d.total_cantidad, d.total_importe,
  d.productos_resumen, d.busq_no_parte, d.busq_nombre, d.busq_ubicacion, d.estado_ids
from public.movimientos m
join public.almacenes a on a.id = m.almacen_id
left join public.usuarios u on u.id = m.usuario_id
left join lateral (
  select
    count(*)                                             as total_items,
    coalesce(sum(md.cantidad), 0)                        as total_cantidad,
    coalesce(sum(md.subtotal), 0)                        as total_importe,
    string_agg(distinct p.nombre, ', ')                  as productos_resumen,
    string_agg(distinct coalesce(p.no_parte, ''), ' ')   as busq_no_parte,
    string_agg(distinct p.nombre, ' ')                   as busq_nombre,
    string_agg(distinct coalesce(md.ubicacion, ''), ' ') as busq_ubicacion,
    array_remove(array_agg(distinct md.estado_id), null) as estado_ids
  from public.movimiento_detalle md
  join public.productos p on p.id = md.producto_id
  where md.movimiento_id = m.id
) d on true;

-- 5.3 Detalle del ticket, con el estado y la ubicación afectados
create view public.vw_movimiento_detalle
with (security_invoker = true) as
select
  md.id, md.movimiento_id, md.producto_id, md.producto_almacen_id,
  md.cantidad, md.costo_unitario, md.subtotal,
  md.estado_id, md.ubicacion,
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

grant select on public.vw_stock_agrupado     to authenticated;
grant select on public.vw_movimientos        to authenticated;
grant select on public.vw_movimiento_detalle to authenticated;
