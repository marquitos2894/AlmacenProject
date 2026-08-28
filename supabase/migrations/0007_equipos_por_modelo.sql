-- =====================================================================
-- 0007 — "Equipos compatibles" pasa a razonar por MODELO, no por unidad.
--
-- Problema: `equipos` guarda unidades físicas, así que dos máquinas del
-- mismo modelo (R1300 series NJB00255 y NJB00263) salían duplicadas en el
-- selector. Peor: al elegir una, el producto quedaba ligado SOLO a esa
-- unidad, y la otra máquina del mismo modelo no figuraba como compatible.
--
-- Una refacción es compatible con un MODELO. Al elegir "R1300 · Caterpillar"
-- se enlazan todas las unidades activas de ese modelo, así el vínculo sigue
-- siendo una FK real a `equipos` (sin tocar el esquema) pero deja de
-- depender de qué unidad se eligió por casualidad.
--
-- Idempotente: puede re-ejecutarse en el SQL Editor de Supabase.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Clave del modelo, en UN solo lugar
--    Normaliza mayúsculas y espacios para que "R1300" y "r1300 " sean el
--    mismo modelo. Se reutiliza en las vistas y en la función de guardado.
-- ---------------------------------------------------------------------

create or replace function public.equipo_modelo_key(p_modelo text, p_marca text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select upper(btrim(coalesce(p_modelo, ''))) || '|' || upper(btrim(coalesce(p_marca, '')));
$$;

-- ---------------------------------------------------------------------
-- 2. Modelos distintos (lo que alimenta el selector)
-- ---------------------------------------------------------------------

create or replace view public.vw_equipos_modelos
with (security_invoker = true) as
select
  public.equipo_modelo_key(e.modelo, e.marca) as modelo_key,
  min(btrim(e.modelo))                        as modelo,
  min(btrim(e.marca))                         as marca,
  count(*)::int                               as unidades,
  array_agg(e.id order by e.id)               as equipo_ids
from public.equipos e
where e.activo
group by public.equipo_modelo_key(e.modelo, e.marca);

-- ---------------------------------------------------------------------
-- 3. Modelos ya asignados a cada producto (para precargar al editar)
-- ---------------------------------------------------------------------

create or replace view public.vw_producto_equipo_modelos
with (security_invoker = true) as
select distinct
  pe.producto_id,
  public.equipo_modelo_key(e.modelo, e.marca) as modelo_key
from public.producto_equipo pe
join public.equipos e on e.id = pe.equipo_id
where e.activo;

-- ---------------------------------------------------------------------
-- 4. Guardado atómico: reemplaza los equipos compatibles de un producto
--    expandiendo cada modelo a todas sus unidades activas.
-- ---------------------------------------------------------------------

create or replace function public.set_producto_equipos(
  p_producto_id bigint,
  p_modelo_keys text[]
)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_insertados integer := 0;
begin
  if p_producto_id is null then
    raise exception 'Falta el producto.';
  end if;

  delete from public.producto_equipo where producto_id = p_producto_id;

  if p_modelo_keys is null or cardinality(p_modelo_keys) = 0 then
    return 0;
  end if;

  insert into public.producto_equipo (producto_id, equipo_id)
  select p_producto_id, e.id
    from public.equipos e
   where e.activo
     and public.equipo_modelo_key(e.modelo, e.marca) = any (p_modelo_keys)
  on conflict do nothing;

  get diagnostics v_insertados = row_count;
  return v_insertados;
end $$;

-- ---------------------------------------------------------------------
-- 5. Permisos
-- ---------------------------------------------------------------------

grant select on public.vw_equipos_modelos          to authenticated;
grant select on public.vw_producto_equipo_modelos  to authenticated;
grant execute on function public.equipo_modelo_key(text, text)        to authenticated;
grant execute on function public.set_producto_equipos(bigint, text[]) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Reparación de datos: completar los vínculos que quedaron a medias.
--    Un producto ligado al R1300 id 1 debe quedar ligado también al id 3.
-- ---------------------------------------------------------------------

insert into public.producto_equipo (producto_id, equipo_id)
select distinct pem.producto_id, e.id
  from public.vw_producto_equipo_modelos pem
  join public.equipos e
    on e.activo
   and public.equipo_modelo_key(e.modelo, e.marca) = pem.modelo_key
on conflict do nothing;
