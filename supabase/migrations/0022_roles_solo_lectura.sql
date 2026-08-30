-- 0022 — Rol de usuario y RLS por rol
--
-- Hasta aquí, todo usuario `authenticated` tenía acceso total (ALL) a cada
-- tabla. Se añade `usuarios.rol` con dos valores:
--   * 'editor' (por defecto): mismo acceso total de siempre.
--   * 'lector': solo SELECT.
--
-- La política única de cada tabla se parte en cuatro (una por operación):
-- SELECT abierto a `authenticated`; INSERT/UPDATE/DELETE exigen `puede_editar()`.
-- Los RPC (registrar_movimiento, cambiar_estado_existencia, set_producto_unidad)
-- son SECURITY INVOKER, así que también quedan bloqueados para 'lector'.

alter table public.usuarios
  add column if not exists rol text not null default 'editor';

alter table public.usuarios
  drop constraint if exists usuarios_rol_check;
alter table public.usuarios
  add constraint usuarios_rol_check check (rol in ('editor', 'lector'));

-- ¿Puede escribir el usuario de la sesión? Sin fila en `usuarios` (primer
-- inicio de sesión aún sin sincronizar) se asume editor, para no romper el
-- flujo actual: el único lector es el que se marca explícitamente.
-- SECURITY INVOKER: `usuarios` ya tiene SELECT abierto a `authenticated`.
create or replace function public.puede_editar()
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(
    (select u.rol = 'editor' and u.activo
       from public.usuarios u
      where u.auth_uid = auth.uid()),
    true
  );
$$;

grant execute on function public.puede_editar() to authenticated;

-- Reescribe la política única de cada tabla de datos en cuatro por operación.
do $$
declare
  t text;
  tablas text[] := array[
    'almacenes','equipo_unidad_operativa','equipos','estados','movimiento_detalle',
    'movimientos','producto_almacen','producto_unidad','productos','proveedores',
    'unidad_operativa','unidades_medida'
  ];
begin
  foreach t in array tablas loop
    execute format('drop policy if exists %I on public.%I', t || '_all_authenticated', t);
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

-- `usuarios`: cada quien puede crear SU fila al iniciar sesión; editar y
-- borrar filas exige rol editor (evita que un lector se ascienda a editor).
drop policy if exists usuarios_all_authenticated on public.usuarios;
drop policy if exists usuarios_select on public.usuarios;
drop policy if exists usuarios_insert on public.usuarios;
drop policy if exists usuarios_update on public.usuarios;
drop policy if exists usuarios_delete on public.usuarios;

create policy usuarios_select on public.usuarios
  for select to authenticated using (true);
create policy usuarios_insert on public.usuarios
  for insert to authenticated with check (auth_uid = auth.uid() or public.puede_editar());
create policy usuarios_update on public.usuarios
  for update to authenticated using (public.puede_editar()) with check (public.puede_editar());
create policy usuarios_delete on public.usuarios
  for delete to authenticated using (public.puede_editar());
