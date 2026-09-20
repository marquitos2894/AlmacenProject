-- =====================================================================
-- 0047 — Catálogo "Tipos de equipo" y nuevos atributos en equipos
-- (año de fabricación, tipo de equipo).
--
-- `tipos_equipo` sigue el mismo patrón que `estados`: catálogo simple,
-- lectura abierta y escritura solo para editores (puede_editar()).
-- `equipos.tipo_equipo_id` es una llave foránea opcional (on delete set
-- null): desactivar o borrar un tipo no debe romper los equipos que ya lo
-- tenían asignado.
--
-- Idempotente.
-- =====================================================================

create table if not exists public.tipos_equipo (
  id          bigint generated always as identity primary key,
  nombre      character varying not null,
  descripcion text,
  activo      boolean not null default true
);

alter table public.tipos_equipo enable row level security;

drop policy if exists tipos_equipo_select on public.tipos_equipo;
create policy tipos_equipo_select on public.tipos_equipo
  for select using (true);

drop policy if exists tipos_equipo_insert on public.tipos_equipo;
create policy tipos_equipo_insert on public.tipos_equipo
  for insert with check (puede_editar());

drop policy if exists tipos_equipo_update on public.tipos_equipo;
create policy tipos_equipo_update on public.tipos_equipo
  for update using (puede_editar()) with check (puede_editar());

drop policy if exists tipos_equipo_delete on public.tipos_equipo;
create policy tipos_equipo_delete on public.tipos_equipo
  for delete using (puede_editar());

grant select, insert, update, delete on public.tipos_equipo to authenticated;

alter table public.equipos
  add column if not exists anio_fabricacion integer,
  add column if not exists tipo_equipo_id bigint references public.tipos_equipo(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.equipos'::regclass and conname = 'ck_equipos_anio_fabricacion'
  ) then
    alter table public.equipos
      add constraint ck_equipos_anio_fabricacion
      check (anio_fabricacion is null or anio_fabricacion between 1900 and extract(year from now())::int + 1);
  end if;
end $$;

create index if not exists idx_equipos_tipo_equipo on public.equipos (tipo_equipo_id);
