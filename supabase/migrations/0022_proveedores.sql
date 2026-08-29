-- =====================================================================
-- 0022 — Proveedores y su referencia en el movimiento.
--
-- La tabla no existía: el movimiento necesitaba una FK a la que apuntar y
-- el selector una lista de dónde leer. Los campos se acordaron con el
-- usuario (variante "completa con RUC", el identificador estándar en Perú).
--
-- Idempotente: puede re-ejecutarse en el SQL Editor de Supabase.
-- =====================================================================

create table if not exists public.proveedores (
  id           bigint generated always as identity primary key,
  codigo       varchar,
  razon_social varchar not null,
  ruc          varchar,
  contacto     varchar,
  telefono     varchar,
  email        varchar,
  direccion    text,
  activo       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Ni el código ni el RUC deben repetirse entre proveedores activos.
-- El código se compara sin distinguir mayúsculas; el RUC es numérico, así
-- que basta con recortar espacios.
create unique index if not exists uq_proveedores_codigo
  on public.proveedores (upper(btrim(codigo)))
  where codigo is not null and btrim(codigo) <> '' and activo;

create unique index if not exists uq_proveedores_ruc
  on public.proveedores (btrim(ruc))
  where ruc is not null and btrim(ruc) <> '' and activo;

create index if not exists idx_proveedores_razon_social
  on public.proveedores (lower(razon_social));

alter table public.proveedores enable row level security;
drop policy if exists proveedores_all_authenticated on public.proveedores;
create policy proveedores_all_authenticated
  on public.proveedores for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------
-- movimientos.id_proveedor
-- on delete set null: dar de baja un proveedor no debe borrar el histórico.
-- ---------------------------------------------------------------------

alter table public.movimientos
  add column if not exists id_proveedor bigint
  references public.proveedores(id) on delete set null;

create index if not exists idx_movimientos_proveedor
  on public.movimientos (id_proveedor);

-- ---------------------------------------------------------------------
-- Lista para el selector
-- ---------------------------------------------------------------------

create or replace view public.vw_proveedores_lista
with (security_invoker = true) as
select
  p.id, p.codigo, p.razon_social, p.ruc, p.contacto, p.telefono, p.email,
  p.direccion, p.activo,
  concat_ws(' · ', nullif(btrim(p.codigo), ''), nullif(btrim(p.razon_social), '')) as etiqueta
from public.proveedores p
where p.activo;

grant select on public.vw_proveedores_lista to authenticated;
