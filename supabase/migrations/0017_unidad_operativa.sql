-- =====================================================================
-- 0017 — Unidades operativas (los proyectos mineros en distintos lugares
--        del Perú) y el historial de qué equipo está en cada una.
--
--   Equipo 1 ──── N  equipo_unidad_operativa  N ──── 1 unidad_operativa
--
-- Nombres: se siguen las convenciones del esquema (`activo` en vez de
-- `active`, `observacion` sin acento) para no mezclar dos estilos.
--
-- Idempotente: puede re-ejecutarse en el SQL Editor de Supabase.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. equipos: se añaden los campos que faltaban del modelo.
--    `no_serie` ya cumple el papel de numero_serie, así que no se duplica.
-- ---------------------------------------------------------------------

alter table public.equipos add column if not exists codigo varchar;
alter table public.equipos add column if not exists nombre varchar;

create unique index if not exists uq_equipos_codigo
  on public.equipos (upper(btrim(codigo)))
  where codigo is not null and btrim(codigo) <> '' and activo;

-- ---------------------------------------------------------------------
-- 2. UNIDAD_OPERATIVA
-- ---------------------------------------------------------------------

create table if not exists public.unidad_operativa (
  id         bigint generated always as identity primary key,
  codigo     varchar,
  nombre     varchar not null,
  proyecto   varchar,
  ubicacion  varchar,
  zona       varchar,
  activo     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_unidad_operativa_codigo
  on public.unidad_operativa (upper(btrim(codigo)))
  where codigo is not null and btrim(codigo) <> '' and activo;

create index if not exists idx_unidad_operativa_nombre on public.unidad_operativa (lower(nombre));

-- ---------------------------------------------------------------------
-- 3. EQUIPO_UNIDAD_OPERATIVA
--    Historial de asignaciones: `fecha_fin` nula = asignación vigente.
-- ---------------------------------------------------------------------

create table if not exists public.equipo_unidad_operativa (
  id                  bigint generated always as identity primary key,
  equipo_id           bigint not null references public.equipos(id) on delete cascade,
  unidad_operativa_id bigint not null references public.unidad_operativa(id) on delete cascade,
  fecha_inicio        date not null default current_date,
  fecha_fin           date,
  estado              varchar,
  observacion         text,
  activo              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.equipo_unidad_operativa'::regclass
      and conname = 'ck_euo_fechas'
  ) then
    alter table public.equipo_unidad_operativa
      add constraint ck_euo_fechas check (fecha_fin is null or fecha_fin >= fecha_inicio);
  end if;
end $$;

create index if not exists idx_euo_equipo on public.equipo_unidad_operativa (equipo_id);
create index if not exists idx_euo_unidad on public.equipo_unidad_operativa (unidad_operativa_id);

-- Un equipo no puede estar en dos proyectos a la vez: como máximo una
-- asignación abierta (sin fecha_fin) por equipo.
create unique index if not exists uq_euo_asignacion_abierta
  on public.equipo_unidad_operativa (equipo_id)
  where fecha_fin is null and activo;

-- ---------------------------------------------------------------------
-- 4. movimientos: a qué unidad operativa pertenece el ticket
-- ---------------------------------------------------------------------

alter table public.movimientos
  add column if not exists id_unidad_operativa bigint
  references public.unidad_operativa(id) on delete set null;

create index if not exists idx_movimientos_unidad_operativa
  on public.movimientos (id_unidad_operativa);

-- ---------------------------------------------------------------------
-- 5. RLS, igual que el resto del esquema
-- ---------------------------------------------------------------------

alter table public.unidad_operativa enable row level security;
drop policy if exists unidad_operativa_all_authenticated on public.unidad_operativa;
create policy unidad_operativa_all_authenticated
  on public.unidad_operativa for all to authenticated using (true) with check (true);

alter table public.equipo_unidad_operativa enable row level security;
drop policy if exists equipo_unidad_operativa_all_authenticated on public.equipo_unidad_operativa;
create policy equipo_unidad_operativa_all_authenticated
  on public.equipo_unidad_operativa for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------
-- 6. Vistas de consulta
-- ---------------------------------------------------------------------

create or replace view public.vw_unidad_operativa_lista
with (security_invoker = true) as
select
  uo.id, uo.codigo, uo.nombre, uo.proyecto, uo.ubicacion, uo.zona, uo.activo,
  concat_ws(' · ', nullif(btrim(uo.codigo), ''), nullif(btrim(uo.nombre), '')) as etiqueta,
  coalesce(a.total, 0) as equipos_asignados
from public.unidad_operativa uo
left join lateral (
  select count(*)::int as total
    from public.equipo_unidad_operativa e
   where e.unidad_operativa_id = uo.id and e.activo and e.fecha_fin is null
) a on true
where uo.activo;

create or replace view public.vw_equipo_unidad_operativa
with (security_invoker = true) as
select
  euo.id, euo.equipo_id, euo.unidad_operativa_id,
  euo.fecha_inicio, euo.fecha_fin, euo.estado, euo.observacion, euo.activo,
  concat_ws('/', nullif(btrim(e.modelo), ''), nullif(btrim(e.no_serie), '')) as equipo_etiqueta,
  e.modelo   as equipo_modelo,
  e.marca    as equipo_marca,
  e.no_serie as equipo_no_serie,
  e.codigo   as equipo_codigo,
  e.nombre   as equipo_nombre,
  uo.nombre    as unidad_nombre,
  uo.codigo    as unidad_codigo,
  uo.proyecto  as unidad_proyecto,
  uo.ubicacion as unidad_ubicacion,
  uo.zona      as unidad_zona,
  (euo.fecha_fin is null) as vigente
from public.equipo_unidad_operativa euo
join public.equipos e on e.id = euo.equipo_id
join public.unidad_operativa uo on uo.id = euo.unidad_operativa_id
where euo.activo;

grant select on public.vw_unidad_operativa_lista  to authenticated;
grant select on public.vw_equipo_unidad_operativa to authenticated;
