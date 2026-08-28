-- =====================================================================
-- 0008 — `equipos` vuelve a ser un catálogo FLOTANTE (sin relaciones).
--
-- Se elimina la tabla puente `producto_equipo`. La compatibilidad se guarda
-- como texto en `productos.equipos_compatible`, tal como estaba planteado
-- en el modelo original. El selector se alimenta de una consulta que agrupa
-- los modelos registrados en `equipos`.
--
-- Antes de borrar se traspasan los vínculos existentes: hay 3 productos con
-- modelos asignados que de otro modo se perderían.
--
-- Consecuencia asumida: al no haber FK, renombrar un modelo en `equipos` no
-- actualiza el texto ya guardado en los productos.
--
-- Idempotente: puede re-ejecutarse en el SQL Editor de Supabase.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Traspasar los datos ANTES de borrar la tabla puente
-- ---------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'producto_equipo'
  ) then
    update public.productos p
       set equipos_compatible = sub.modelos
      from (
        select pe.producto_id,
               string_agg(distinct btrim(e.modelo), ', ' order by btrim(e.modelo)) as modelos
          from public.producto_equipo pe
          join public.equipos e on e.id = pe.equipo_id
         where e.modelo is not null and btrim(e.modelo) <> ''
         group by pe.producto_id
      ) sub
     where sub.producto_id = p.id
       and (p.equipos_compatible is null or btrim(p.equipos_compatible) = '');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. Retirar todo lo que dependía de la tabla puente
-- ---------------------------------------------------------------------

drop view if exists public.vw_producto_equipo_modelos;
drop function if exists public.set_producto_equipos(bigint, text[]);
drop table if exists public.producto_equipo;

-- Ya no hace falta una clave compuesta: se agrupa por modelo a secas.
drop view if exists public.vw_equipos_modelos;
drop function if exists public.equipo_modelo_key(text, text);

-- ---------------------------------------------------------------------
-- 3. La consulta que alimenta el selector: modelos agrupados, sin repetir.
--    `equipos` guarda una fila por unidad física, así que dos R1300 con
--    series distintas deben aparecer como un solo modelo.
-- ---------------------------------------------------------------------

create or replace view public.vw_equipos_modelos
with (security_invoker = true) as
select
  btrim(e.modelo)                              as modelo,
  min(btrim(e.marca))                          as marca,
  count(*)::int                                as unidades
from public.equipos e
where e.activo
  and e.modelo is not null
  and btrim(e.modelo) <> ''
group by btrim(e.modelo)
order by btrim(e.modelo);

grant select on public.vw_equipos_modelos to authenticated;
