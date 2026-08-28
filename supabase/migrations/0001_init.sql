-- =====================================================================
-- Sistema de Gestión de Almacén — Esquema inicial
-- Modelo basado en database.md + ajustes documentados en el plan:
--   * Junction producto_equipo (multiselect + conecta EQUIPOS)
--   * usuarios.auth_uid (enlace con auth.users)
--   * Vistas planas con security_invoker para las pantallas dependientes
-- Idempotente: puede re-ejecutarse en el SQL Editor de Supabase.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. CATÁLOGOS
-- ---------------------------------------------------------------------

create table if not exists public.unidades_medida (
  id          bigint generated always as identity primary key,
  codigo      varchar not null unique,
  nombre      varchar not null,
  activo      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.estados (
  id          bigint generated always as identity primary key,
  nombre      varchar not null,
  descripcion text,
  activo      boolean not null default true
);

create table if not exists public.almacenes (
  id          bigint generated always as identity primary key,
  nombre      varchar not null,
  ubicacion   varchar,
  descripcion text,
  activo      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.equipos (
  id             bigint generated always as identity primary key,
  modelo         varchar,
  marca          varchar,
  no_serie       varchar,
  unidad_actual  varchar,
  estado_actual  varchar,
  activo         boolean not null default true
);

-- Usuarios de negocio (para atribuir movimientos). Enlazados a auth.users.
create table if not exists public.usuarios (
  id          bigint generated always as identity primary key,
  auth_uid    uuid unique,
  nombre      varchar,
  apellido    varchar,
  email       varchar,
  activo      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. PRODUCTOS
-- ---------------------------------------------------------------------

create table if not exists public.productos (
  id                 bigint generated always as identity primary key,
  codigo_interno     varchar unique,
  codigo_erp         varchar,
  nombre             varchar not null,
  descripcion        text,
  no_parte           varchar,
  no_serie           varchar,
  marca              varchar,
  equipos_compatible text,                    -- se mantiene por compatibilidad; el form usa producto_equipo
  activoFijo         boolean not null default false,
  modelo             varchar,
  unidad_medida_id   bigint references public.unidades_medida(id),
  activo             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Junction N:M productos <-> equipos (equipos compatibles / multiselect)
create table if not exists public.producto_equipo (
  producto_id bigint not null references public.productos(id) on delete cascade,
  equipo_id   bigint not null references public.equipos(id)   on delete cascade,
  primary key (producto_id, equipo_id)
);

-- ---------------------------------------------------------------------
-- 3. STOCK Y MOVIMIENTOS
-- ---------------------------------------------------------------------

create table if not exists public.producto_almacen (
  id            bigint generated always as identity primary key,
  producto_id   bigint not null references public.productos(id),
  almacen_id    bigint not null references public.almacenes(id),
  ubicacion     varchar,
  stock_actual  numeric not null default 0,
  estado_id     bigint references public.estados(id),
  activo        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Log append-only (sin columna activo, tal como el modelo original)
create table if not exists public.movimientos (
  id                  bigint generated always as identity primary key,
  producto_almacen_id bigint not null references public.producto_almacen(id),
  fecha               date not null default current_date,
  tipo_movimiento     varchar not null,      -- 'entrada' | 'salida'
  cantidad            numeric not null,
  motivo              varchar,
  descripcion         text,
  usuario_id          bigint references public.usuarios(id),
  created_at          timestamptz not null default now()
);

-- Índices útiles para los filtros de las vistas
create index if not exists idx_producto_almacen_almacen on public.producto_almacen(almacen_id);
create index if not exists idx_producto_almacen_producto on public.producto_almacen(producto_id);
create index if not exists idx_movimientos_pa on public.movimientos(producto_almacen_id);

-- ---------------------------------------------------------------------
-- 4. VISTAS PLANAS (security_invoker => respetan RLS del usuario)
-- ---------------------------------------------------------------------

create or replace view public.vw_producto_almacen
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
  p.codigo_interno as codigo_interno,
  p.modelo as modelo,
  p.no_serie as no_serie,
  p.marca          as marca,
  a.nombre         as almacen_nombre,
  e.nombre         as estado_nombre
from public.producto_almacen pa
join public.productos p on p.id = pa.producto_id
join public.almacenes a on a.id = pa.almacen_id
left join public.estados e on e.id = pa.estado_id
where pa.activo = true;

create or replace view public.vw_movimientos
with (security_invoker = true) as
select
  m.id,
  m.producto_almacen_id,
  m.fecha,
  m.tipo_movimiento,
  m.cantidad,
  m.motivo,
  m.descripcion,
  m.usuario_id,
  m.created_at,
  pa.almacen_id,
  pa.producto_id,
  pa.estado_id,
  a.nombre         as almacen_nombre,
  p.nombre         as producto_nombre,
  p.no_parte       as no_parte,
  e.nombre         as estado_nombre,
  trim(coalesce(u.nombre, '') || ' ' || coalesce(u.apellido, '')) as usuario_nombre
from public.movimientos m
join public.producto_almacen pa on pa.id = m.producto_almacen_id
join public.almacenes a on a.id = pa.almacen_id
join public.productos p on p.id = pa.producto_id
left join public.estados e on e.id = pa.estado_id
left join public.usuarios u on u.id = m.usuario_id;

-- ---------------------------------------------------------------------
-- 5. RLS — herramienta interna: acceso total a usuarios autenticados
-- ---------------------------------------------------------------------

do $$
declare
  t text;
  tbls text[] := array[
    'unidades_medida','estados','almacenes','equipos','usuarios',
    'productos','producto_equipo','producto_almacen','movimientos'
  ];
begin
  foreach t in array tbls loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %I on public.%I;', t || '_all_authenticated', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (true) with check (true);',
      t || '_all_authenticated', t
    );
  end loop;
end $$;

-- Acceso de lectura a las vistas para usuarios autenticados
grant select on public.vw_producto_almacen to authenticated;
grant select on public.vw_movimientos to authenticated;

-- ---------------------------------------------------------------------
-- 6. SEED mínimo (idempotente)
-- ---------------------------------------------------------------------

insert into public.unidades_medida (codigo, nombre)
values ('PZA','Pieza'), ('LTS','Litros'), ('KG','Kilogramos'), ('MTS','Metros')
on conflict (codigo) do nothing;

insert into public.estados (nombre, descripcion)
select v.nombre, v.descripcion
from (values
  ('Disponible','Producto disponible para uso'),
  ('En uso','Producto asignado o en uso'),
  ('Dañado','Producto dañado / no utilizable'),
  ('Baja','Producto dado de baja')
) as v(nombre, descripcion)
where not exists (select 1 from public.estados e where e.nombre = v.nombre);

insert into public.almacenes (nombre, ubicacion, descripcion)
select v.nombre, v.ubicacion, v.descripcion
from (values
  ('Almacén Central','Planta baja','Almacén principal'),
  ('Almacén Secundario','Bodega norte','Almacén de respaldo')
) as v(nombre, ubicacion, descripcion)
where not exists (select 1 from public.almacenes a where a.nombre = v.nombre);

insert into public.equipos (modelo, marca, no_serie, unidad_actual, estado_actual)
select v.modelo, v.marca, v.no_serie, v.unidad_actual, v.estado_actual
from (values
  ('CAT 320','Caterpillar','SN-320-001','Unidad 1','Operativo'),
  ('Komatsu PC200','Komatsu','SN-PC200-002','Unidad 2','Operativo')
) as v(modelo, marca, no_serie, unidad_actual, estado_actual)
where not exists (select 1 from public.equipos e where e.no_serie = v.no_serie);
