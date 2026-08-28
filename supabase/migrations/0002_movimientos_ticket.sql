-- =====================================================================
-- 0002 — Código de barras, movimientos maestro-detalle (ticket) y
--        stock agrupado por no_parte.
--
-- Decisiones aplicadas:
--   * Serie = atributo del PRODUCTO (productos.no_serie).
--   * Folio  = secuencia GLOBAL, formateado TKT-{AAMMDD}-{####}.
--   * codigo_barras generado por trigger: manual > BAR-{no_parte} > SYS-{id}.
--   * Stock Inicial SOBRESCRIBE la existencia del producto en el almacén.
--   * Sin permisos por almacén (RLS sigue abierto a authenticated).
--
-- Idempotente: puede re-ejecutarse en el SQL Editor de Supabase.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. PRODUCTOS — código de barras
-- ---------------------------------------------------------------------

alter table public.productos add column if not exists codigo_barras varchar(100);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.productos'::regclass and conname = 'productos_codigo_barras_key'
  ) then
    alter table public.productos add constraint productos_codigo_barras_key unique (codigo_barras);
  end if;
end $$;

-- Genera el código de barras según la prioridad: manual > BAR-{no_parte} > SYS-{id}.
-- Nota: en un BEFORE INSERT de Postgres, NEW.id ya está poblado (identity).
create or replace function public.fn_productos_codigo_barras()
returns trigger
language plpgsql
as $$
declare
  base      text;
  candidate text;
begin
  -- 1) Registro manual: se respeta tal cual.
  if new.codigo_barras is not null and btrim(new.codigo_barras) <> '' then
    new.codigo_barras := btrim(new.codigo_barras);
    return new;
  end if;

  -- 2) Derivado del no_parte (espacios -> guion bajo).
  if new.no_parte is not null and btrim(new.no_parte) <> '' then
    base      := 'BAR-' || regexp_replace(btrim(new.no_parte), '\s+', '_', 'g');
    candidate := base;
    -- Desambiguar: no_parte no es único, el código de barras sí.
    if exists (
      select 1 from public.productos p
      where p.codigo_barras = candidate and p.id <> new.id
    ) then
      candidate := base || '-' || new.id::text;
    end if;
  else
    -- 3) Fallback del sistema.
    candidate := 'SYS-' || new.id::text;
  end if;

  new.codigo_barras := left(candidate, 100);
  return new;
end $$;

drop trigger if exists trg_productos_codigo_barras on public.productos;
create trigger trg_productos_codigo_barras
  before insert or update on public.productos
  for each row execute function public.fn_productos_codigo_barras();

-- Backfill de los productos existentes (dispara el trigger de UPDATE).
update public.productos set codigo_barras = null where codigo_barras is null;

-- ---------------------------------------------------------------------
-- 2. MOVIMIENTOS — encabezado (ticket) + detalle (carrito)
-- ---------------------------------------------------------------------

-- Las vistas de 0001 referencian columnas que este archivo va a eliminar
-- (producto_almacen_id, cantidad); hay que soltarlas antes de tocar la tabla.
drop view if exists public.vw_movimientos;
drop view if exists public.vw_producto_almacen;

-- 2.1 Nuevas columnas del encabezado
alter table public.movimientos add column if not exists folio            varchar(30);
alter table public.movimientos add column if not exists almacen_id       bigint references public.almacenes(id);
alter table public.movimientos add column if not exists es_stock_inicial boolean not null default false;
alter table public.movimientos add column if not exists observaciones    text;

-- 2.2 Tabla de detalle (líneas del carrito)
create table if not exists public.movimiento_detalle (
  id             bigint generated always as identity primary key,
  movimiento_id  bigint not null references public.movimientos(id) on delete cascade,
  producto_id    bigint not null references public.productos(id),
  cantidad       numeric not null,
  costo_unitario numeric not null default 0,
  subtotal       numeric generated always as (cantidad * coalesce(costo_unitario, 0)) stored,
  created_at     timestamptz not null default now()
);

-- 2.3 Migración de datos del modelo anterior (1 fila = 1 movimiento de 1 producto)
do $$
begin
  -- Backfill del almacén en el encabezado desde el stock referenciado
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'movimientos' and column_name = 'producto_almacen_id'
  ) then
    update public.movimientos m
       set almacen_id = pa.almacen_id
      from public.producto_almacen pa
     where pa.id = m.producto_almacen_id and m.almacen_id is null;

    -- Mover cada movimiento antiguo a una línea de detalle
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'movimientos' and column_name = 'cantidad'
    ) then
      insert into public.movimiento_detalle (movimiento_id, producto_id, cantidad)
      select m.id, pa.producto_id, m.cantidad
        from public.movimientos m
        join public.producto_almacen pa on pa.id = m.producto_almacen_id
       where not exists (
         select 1 from public.movimiento_detalle d where d.movimiento_id = m.id
       );
    end if;
  end if;
end $$;

-- 2.4 Retirar las columnas del modelo anterior
alter table public.movimientos drop column if exists producto_almacen_id;
alter table public.movimientos drop column if exists cantidad;

-- 2.5 Folio — secuencia global
create sequence if not exists public.movimientos_folio_seq;

create or replace function public.fn_movimientos_folio()
returns trigger
language plpgsql
as $$
begin
  if new.folio is null or btrim(new.folio) = '' then
    new.folio := 'TKT-'
              || to_char(coalesce(new.fecha, current_date), 'YYMMDD')
              || '-'
              || lpad(nextval('public.movimientos_folio_seq')::text, 4, '0');
  end if;
  return new;
end $$;

drop trigger if exists trg_movimientos_folio on public.movimientos;
create trigger trg_movimientos_folio
  before insert on public.movimientos
  for each row execute function public.fn_movimientos_folio();

-- Backfill de folios para movimientos previos
update public.movimientos
   set folio = 'TKT-' || to_char(coalesce(fecha, current_date), 'YYMMDD')
            || '-' || lpad(nextval('public.movimientos_folio_seq')::text, 4, '0')
 where folio is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.movimientos'::regclass and conname = 'movimientos_folio_key'
  ) then
    alter table public.movimientos add constraint movimientos_folio_key unique (folio);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. ÍNDICES para el autocompletado (nota técnica 5.1)
-- ---------------------------------------------------------------------

create index if not exists idx_productos_no_parte      on public.productos (lower(no_parte));
create index if not exists idx_productos_nombre        on public.productos (lower(nombre));
create index if not exists idx_productos_no_serie      on public.productos (lower(no_serie));
create index if not exists idx_productos_codigo_barras on public.productos (codigo_barras);
create index if not exists idx_mov_detalle_movimiento  on public.movimiento_detalle (movimiento_id);
create index if not exists idx_mov_detalle_producto    on public.movimiento_detalle (producto_id);
create index if not exists idx_movimientos_almacen     on public.movimientos (almacen_id);

-- ---------------------------------------------------------------------
-- 4. VISTAS
--    (vw_movimientos y vw_producto_almacen ya se soltaron en la sección 2,
--     antes de eliminar las columnas de las que dependían)
-- ---------------------------------------------------------------------

drop view if exists public.vw_movimiento_detalle;
drop view if exists public.vw_stock_agrupado;

-- 4.1 Stock detallado (incluye serie, modelo y código de barras)
create view public.vw_producto_almacen
with (security_invoker = true) as
select
  pa.id,
  pa.producto_id,
  pa.almacen_id,
  pa.estado_id,
  pa.ubicacion,
  pa.stock_actual,
  pa.activo,
  pa.created_at,
  pa.updated_at,
  p.nombre         as producto_nombre,
  p.no_parte       as no_parte,
  p.no_serie       as no_serie,
  p.modelo         as modelo,
  p.marca          as marca,
  p.codigo_interno as codigo_interno,
  p.codigo_barras  as codigo_barras,
  a.nombre         as almacen_nombre,
  e.nombre         as estado_nombre
from public.producto_almacen pa
join public.productos p on p.id = pa.producto_id
join public.almacenes a on a.id = pa.almacen_id
left join public.estados e on e.id = pa.estado_id
where pa.activo = true;

-- 4.2 Stock agrupado por no_parte (suma en SQL — nota técnica 5.3)
create view public.vw_stock_agrupado
with (security_invoker = true) as
select
  pa.almacen_id,
  a.nombre                as almacen_nombre,
  p.no_parte              as no_parte,
  min(p.nombre)           as producto_nombre,
  sum(pa.stock_actual)    as stock_total,
  count(*)                as total_series,
  min(p.marca)            as marca
from public.producto_almacen pa
join public.productos p on p.id = pa.producto_id
join public.almacenes a on a.id = pa.almacen_id
where pa.activo = true
group by pa.almacen_id, a.nombre, p.no_parte;

-- 4.3 Encabezados de movimiento (tickets), con agregados y campos de búsqueda
create view public.vw_movimientos
with (security_invoker = true) as
select
  m.id,
  m.folio,
  m.fecha,
  m.tipo_movimiento,
  m.es_stock_inicial,
  m.motivo,
  m.observaciones,
  m.almacen_id,
  a.nombre as almacen_nombre,
  m.usuario_id,
  trim(coalesce(u.nombre, '') || ' ' || coalesce(u.apellido, '')) as usuario_nombre,
  m.created_at,
  d.total_items,
  d.total_cantidad,
  d.total_importe,
  d.productos_resumen,
  d.busq_no_parte,
  d.busq_nombre,
  d.estado_ids
from public.movimientos m
join public.almacenes a on a.id = m.almacen_id
left join public.usuarios u on u.id = m.usuario_id
left join lateral (
  select
    count(*)                                          as total_items,
    coalesce(sum(md.cantidad), 0)                     as total_cantidad,
    coalesce(sum(md.subtotal), 0)                     as total_importe,
    string_agg(distinct p.nombre, ', ')               as productos_resumen,
    string_agg(distinct coalesce(p.no_parte, ''), ' ') as busq_no_parte,
    string_agg(distinct p.nombre, ' ')                as busq_nombre,
    array_remove(array_agg(distinct pa.estado_id), null) as estado_ids
  from public.movimiento_detalle md
  join public.productos p on p.id = md.producto_id
  left join public.producto_almacen pa
         on pa.producto_id = md.producto_id and pa.almacen_id = m.almacen_id
  where md.movimiento_id = m.id
) d on true;

-- 4.4 Detalle de movimiento (líneas del ticket)
create view public.vw_movimiento_detalle
with (security_invoker = true) as
select
  md.id,
  md.movimiento_id,
  md.producto_id,
  md.cantidad,
  md.costo_unitario,
  md.subtotal,
  m.folio,
  m.fecha,
  m.tipo_movimiento,
  m.almacen_id,
  p.nombre        as producto_nombre,
  p.no_parte      as no_parte,
  p.no_serie      as no_serie,
  p.codigo_barras as codigo_barras
from public.movimiento_detalle md
join public.movimientos m on m.id = md.movimiento_id
join public.productos p on p.id = md.producto_id;

-- ---------------------------------------------------------------------
-- 5. RLS y permisos
-- ---------------------------------------------------------------------

alter table public.movimiento_detalle enable row level security;
drop policy if exists movimiento_detalle_all_authenticated on public.movimiento_detalle;
create policy movimiento_detalle_all_authenticated
  on public.movimiento_detalle for all to authenticated
  using (true) with check (true);

grant select on public.vw_producto_almacen  to authenticated;
grant select on public.vw_stock_agrupado    to authenticated;
grant select on public.vw_movimientos       to authenticated;
grant select on public.vw_movimiento_detalle to authenticated;

-- ---------------------------------------------------------------------
-- 6. RPC — registra el ticket completo de forma ATÓMICA
--    (encabezado + líneas del carrito + ajuste de stock en una transacción)
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
as $$
declare
  v_mov         public.movimientos;
  v_item        jsonb;
  v_producto_id bigint;
  v_cantidad    numeric;
  v_costo       numeric;
  v_pa          public.producto_almacen;
  v_nuevo       numeric;
  v_nombre      text;
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

    if v_cantidad is null or v_cantidad <= 0 then
      raise exception 'La cantidad debe ser mayor que cero.';
    end if;

    insert into public.movimiento_detalle (movimiento_id, producto_id, cantidad, costo_unitario)
    values (v_mov.id, v_producto_id, v_cantidad, v_costo);

    select * into v_pa
      from public.producto_almacen
     where producto_id = v_producto_id and almacen_id = p_almacen_id
     limit 1;

    if not found then
      insert into public.producto_almacen (producto_id, almacen_id, stock_actual)
      values (v_producto_id, p_almacen_id, 0)
      returning * into v_pa;
    end if;

    if coalesce(p_es_stock_inicial, false) then
      v_nuevo := v_cantidad;                                   -- Stock Inicial: sobrescribe
    elsif p_tipo_movimiento = 'salida' then
      v_nuevo := coalesce(v_pa.stock_actual, 0) - v_cantidad;  -- Salida: resta
    else
      v_nuevo := coalesce(v_pa.stock_actual, 0) + v_cantidad;  -- Entrada: suma
    end if;

    if v_nuevo < 0 then
      select nombre into v_nombre from public.productos where id = v_producto_id;
      raise exception 'Stock insuficiente para "%": disponible %, solicitado %.',
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
