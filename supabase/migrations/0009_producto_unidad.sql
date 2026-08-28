-- =====================================================================
-- 0009 — Tabla `producto_unidad`: las unidades físicas de un producto.
--
-- `productos` describe el artículo de catálogo; `producto_unidad` describe
-- cada máquina o pieza concreta con su propia serie, modelo y estado.
-- Es lo que permite tener un solo producto "Perforadora HLX5" con varias
-- unidades, en lugar de una fila de producto por cada máquina.
--
-- Decisiones confirmadas con el usuario:
--   * Estado -> FK al catálogo `estados` (consistente con producto_almacen).
--   * No. de serie y código interno son únicos entre unidades activas.
--
-- Nombres: se siguen las convenciones ya existentes en el esquema
-- (`no_parte`, `no_serie`, `codigo_interno`, `activo`) en lugar de
-- `Nro_parte` / `Active`, para que las consultas no mezclen dos estilos.
-- Postgres además pasa a minúsculas cualquier identificador sin comillas.
--
-- Idempotente: puede re-ejecutarse en el SQL Editor de Supabase.
-- =====================================================================

create table if not exists public.producto_unidad (
  id             bigint generated always as identity primary key,
  producto_id    bigint not null references public.productos(id) on delete cascade,
  modelo         varchar,
  no_parte       varchar,
  no_serie       varchar,
  codigo_interno varchar,
  marca          varchar,
  estado_id      bigint references public.estados(id),
  activo         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Índices
-- ---------------------------------------------------------------------

create index if not exists idx_producto_unidad_producto on public.producto_unidad (producto_id);
create index if not exists idx_producto_unidad_estado   on public.producto_unidad (estado_id);
create index if not exists idx_producto_unidad_no_parte on public.producto_unidad (lower(no_parte));

-- Una serie identifica una unidad física: no puede repetirse. Se ignoran
-- los vacíos y las unidades dadas de baja, para que desactivar libere el valor.
create unique index if not exists uq_producto_unidad_no_serie
  on public.producto_unidad (upper(btrim(no_serie)))
  where no_serie is not null and btrim(no_serie) <> '' and activo;

create unique index if not exists uq_producto_unidad_codigo_interno
  on public.producto_unidad (upper(btrim(codigo_interno)))
  where codigo_interno is not null and btrim(codigo_interno) <> '' and activo;

-- ---------------------------------------------------------------------
-- RLS — misma política que el resto del esquema
-- ---------------------------------------------------------------------

alter table public.producto_unidad enable row level security;
drop policy if exists producto_unidad_all_authenticated on public.producto_unidad;
create policy producto_unidad_all_authenticated
  on public.producto_unidad for all to authenticated
  using (true) with check (true);

-- ---------------------------------------------------------------------
-- Vista de consulta: unidad + su producto y su estado ya resueltos
-- ---------------------------------------------------------------------

create or replace view public.vw_producto_unidad
with (security_invoker = true) as
select
  u.id,
  u.producto_id,
  u.modelo,
  u.no_parte,
  u.no_serie,
  u.codigo_interno,
  u.marca,
  u.estado_id,
  u.activo,
  u.created_at,
  u.updated_at,
  p.nombre        as producto_nombre,
  p.codigo_barras as producto_codigo_barras,
  p.activofijo    as producto_activofijo,
  e.nombre        as estado_nombre
from public.producto_unidad u
join public.productos p on p.id = u.producto_id
left join public.estados e on e.id = u.estado_id
where u.activo = true;

grant select on public.vw_producto_unidad to authenticated;
