-- =====================================================================
-- 0024 — Transferencias de stock entre almacenes
--
-- Hasta aquí mover existencias de un almacén a otro solo se podía imitar
-- con dos tickets sueltos en Movimientos (una salida y una entrada) sin
-- nada que los relacionara. Este cambio añade un proceso propio:
--
--   * Tablas `transferencias` (cabecera, folio TRF-…) y
--     `transferencia_detalle` (renglones).
--   * RPC `registrar_transferencia(...)` que, en una sola transacción,
--     resta stock en el origen y lo suma/fusiona en el destino.
--   * Vistas `vw_transferencias` y `vw_transferencia_detalle` para el
--     historial y el ticket.
--
-- NO se toca `movimientos` ni `registrar_movimiento`. El stock real
-- (`producto_almacen.stock_actual`) sí se actualiza, así que Stock por
-- almacén y el Panel siguen cuadrando.
--
-- Idempotente: puede re-ejecutarse en el SQL Editor de Supabase.
-- =====================================================================

-- --------------------------------------------------------------- Tablas
create table if not exists public.transferencias (
  id                 bigint generated always as identity primary key,
  folio              varchar(30) unique,
  fecha              date not null default current_date,
  almacen_origen_id  bigint not null references public.almacenes(id),
  almacen_destino_id bigint not null references public.almacenes(id),
  motivo             varchar,
  observaciones      text,
  usuario_id         bigint references public.usuarios(id),
  created_at         timestamptz not null default now(),
  constraint ck_transferencias_distintos check (almacen_origen_id <> almacen_destino_id)
);

create table if not exists public.transferencia_detalle (
  id                          bigint generated always as identity primary key,
  transferencia_id            bigint not null references public.transferencias(id) on delete cascade,
  producto_id                 bigint not null references public.productos(id),
  cantidad                    numeric not null check (cantidad > 0),
  estado_id                   bigint references public.estados(id),
  ubicacion_origen            varchar,
  ubicacion_destino           varchar,
  producto_almacen_id_origen  bigint references public.producto_almacen(id),
  producto_almacen_id_destino bigint references public.producto_almacen(id),
  created_at                  timestamptz not null default now()
);

create index if not exists idx_transf_detalle_transf   on public.transferencia_detalle (transferencia_id);
create index if not exists idx_transf_detalle_producto on public.transferencia_detalle (producto_id);
create index if not exists idx_transferencias_origen   on public.transferencias (almacen_origen_id);
create index if not exists idx_transferencias_destino  on public.transferencias (almacen_destino_id);

-- ---------------------------------------------------------------- Folio
-- Mismo criterio que `fn_movimientos_folio`: TRF-YYMMDD-#### correlativo.
create sequence if not exists public.transferencias_folio_seq;

create or replace function public.fn_transferencias_folio()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.folio is null or btrim(new.folio) = '' then
    new.folio := 'TRF-'
              || to_char(coalesce(new.fecha, current_date), 'YYMMDD')
              || '-'
              || lpad(nextval('public.transferencias_folio_seq')::text, 4, '0');
  end if;
  return new;
end $$;

drop trigger if exists trg_transferencias_folio on public.transferencias;
create trigger trg_transferencias_folio
  before insert on public.transferencias
  for each row execute function public.fn_transferencias_folio();

-- ------------------------------------------------------------------ RLS
-- Mismo patrón que 0022: SELECT abierto, escritura solo para editor.
alter table public.transferencias      enable row level security;
alter table public.transferencia_detalle enable row level security;

do $$
declare
  t text;
  tablas text[] := array['transferencias', 'transferencia_detalle'];
begin
  foreach t in array tablas loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);

    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.puede_editar())', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.puede_editar()) with check (public.puede_editar())', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.puede_editar())', t || '_delete', t);
  end loop;
end $$;

-- ------------------------------------------------------------------ RPC
-- registrar_transferencia: una llamada = una cabecera + N renglones +
-- los ajustes de stock en origen y destino, todo en una transacción.
--
-- p_items: [{ producto_almacen_id_origen, producto_id, cantidad, ubicacion_destino }]
--
-- Destino: conserva el estado de la existencia de origen; la ubicación
-- destino es opcional (vacía => se usa la de origen). En consumibles, si
-- ya hay una existencia con el mismo grano en el destino, se fusiona.
-- En trazables se relocaliza la existencia única (regla 1 pieza = 1 almacén).
create or replace function public.registrar_transferencia(
  p_almacen_origen_id  bigint,
  p_almacen_destino_id bigint,
  p_fecha              date,
  p_motivo             varchar,
  p_observaciones      text,
  p_usuario_id         bigint,
  p_items              jsonb
) returns public.transferencias
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
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
      -- Una pieza trazable no se transfiere por partes.
      if v_cantidad <> coalesce(v_pa_o.stock_actual, 0) then
        raise exception
          'El componente trazable "%" se transfiere completo (stock %); no admite cantidades parciales.',
          coalesce(v_nombre, v_producto_id::text), coalesce(v_pa_o.stock_actual, 0);
      end if;

      -- Relocaliza la MISMA existencia: sigue habiendo una sola fila activa
      -- del producto, ahora en el almacén destino.
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

      -- Destino: fusiona por grano (producto + almacén + estado + ubicación).
      select * into v_pa_d
        from public.producto_almacen
       where producto_id = v_producto_id
         and almacen_id  = p_almacen_destino_id
         and activo
         and estado_id is not distinct from v_estado_id
         and ubicacion_norm is not distinct from nullif(upper(btrim(coalesce(v_ubic_dest, ''))), '')
       limit 1;

      if found then
        update public.producto_almacen
           set stock_actual = coalesce(stock_actual, 0) + v_cantidad,
               activo = true, updated_at = now()
         where id = v_pa_d.id
        returning * into v_pa_d;
      else
        insert into public.producto_almacen
          (producto_id, almacen_id, stock_actual, estado_id, ubicacion)
        values
          (v_producto_id, p_almacen_destino_id, v_cantidad, v_estado_id, v_ubic_dest)
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
end $$;

grant execute on function public.registrar_transferencia(
  bigint, bigint, date, varchar, text, bigint, jsonb
) to authenticated;

-- ---------------------------------------------------------------- Vistas
drop view if exists public.vw_transferencias;
create view public.vw_transferencias
with (security_invoker = true) as
select
  t.id, t.folio, t.fecha, t.motivo, t.observaciones, t.created_at,
  t.almacen_origen_id,  ao.nombre as almacen_origen_nombre,
  t.almacen_destino_id, ad.nombre as almacen_destino_nombre,
  t.usuario_id,
  trim(coalesce(u.nombre, '') || ' ' || coalesce(u.apellido, '')) as usuario_nombre,
  d.total_items, d.total_cantidad,
  d.productos_resumen, d.busq_no_parte, d.busq_nombre
from public.transferencias t
join public.almacenes ao on ao.id = t.almacen_origen_id
join public.almacenes ad on ad.id = t.almacen_destino_id
left join public.usuarios u on u.id = t.usuario_id
left join lateral (
  select
    count(*)                                           as total_items,
    coalesce(sum(td.cantidad), 0)                      as total_cantidad,
    string_agg(distinct p.nombre, ', ')                as productos_resumen,
    string_agg(distinct coalesce(p.no_parte, ''), ' ') as busq_no_parte,
    string_agg(distinct p.nombre, ' ')                 as busq_nombre
  from public.transferencia_detalle td
  join public.productos p on p.id = td.producto_id
  where td.transferencia_id = t.id
) d on true;

grant select on public.vw_transferencias to authenticated;

drop view if exists public.vw_transferencia_detalle;
create view public.vw_transferencia_detalle
with (security_invoker = true) as
select
  td.id, td.transferencia_id, td.producto_id, td.cantidad,
  td.estado_id, e.nombre as estado_nombre,
  td.ubicacion_origen, td.ubicacion_destino,
  t.folio, t.fecha,
  t.almacen_origen_id,  ao.nombre as almacen_origen_nombre,
  t.almacen_destino_id, ad.nombre as almacen_destino_nombre,
  p.nombre        as producto_nombre,
  p.no_parte      as no_parte,
  p.codigo_barras as codigo_barras,
  u.series        as no_serie
from public.transferencia_detalle td
join public.transferencias t on t.id = td.transferencia_id
join public.almacenes ao on ao.id = t.almacen_origen_id
join public.almacenes ad on ad.id = t.almacen_destino_id
join public.productos p on p.id = td.producto_id
left join public.estados e on e.id = td.estado_id
left join lateral (
  select string_agg(btrim(pu.no_serie), ', ' order by btrim(pu.no_serie)) as series
    from public.producto_unidad pu
   where pu.producto_id = td.producto_id and pu.activo
     and pu.no_serie is not null and btrim(pu.no_serie) <> ''
) u on true;

grant select on public.vw_transferencia_detalle to authenticated;
