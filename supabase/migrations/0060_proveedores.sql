-- =====================================================================
-- 0060 — Proveedores: la tabla, sus índices y su vista, versionados.
--
-- Problema: `proveedores`, `movimientos.id_proveedor` y `vw_proveedores_lista`
-- se crearon directamente en Supabase y ningún archivo de `migrations/` los
-- define, aunque 0022 (roles), 0042, 0056 y 0058 ya dependen de ellos. Una base
-- nueva montada solo con estos archivos fallaría al llegar a 0022.
--
-- Esta migración reproduce la definición acordada con el usuario (variante
-- "completa con RUC", el identificador estándar en Perú). En la base actual es
-- un no-op; en una base nueva debe ejecutarse ANTES de la 0022 (roles).
--
-- RLS: el patrón vigente desde 0022 (SELECT abierto; INSERT/UPDATE/DELETE con
-- `puede_editar()`), no la política "todo para authenticated" original.
--
-- Idempotente.
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
drop policy if exists proveedores_select on public.proveedores;
drop policy if exists proveedores_insert on public.proveedores;
drop policy if exists proveedores_update on public.proveedores;
drop policy if exists proveedores_delete on public.proveedores;

create policy proveedores_select on public.proveedores
  for select to authenticated using (true);
create policy proveedores_insert on public.proveedores
  for insert to authenticated with check (public.puede_editar());
create policy proveedores_update on public.proveedores
  for update to authenticated using (public.puede_editar()) with check (public.puede_editar());
create policy proveedores_delete on public.proveedores
  for delete to authenticated using (public.puede_editar());

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
-- Lista para el selector de Movimientos
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
