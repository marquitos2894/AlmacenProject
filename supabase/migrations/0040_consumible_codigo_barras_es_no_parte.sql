-- =====================================================================
-- 0040 — El código de barras de un consumible es su número de parte.
--
-- Antes: consumible sin código de barras -> `codigo_barras = 'BAR-' || no_parte`
-- (con `-<id>` si chocaba). Ahora el `codigo_barras` es el número de parte tal
-- cual (normalizando espacios a `_`), sin el prefijo `BAR-`, para que el código
-- impreso coincida con el número de parte real.
--
-- El resto de la lógica de código de barras no cambia:
--   - un valor escrito por el usuario se respeta;
--   - un componente (trazable) sigue tomándolo de su serie / código interno
--     (migración 0039, vía set_producto_unidad);
--   - consumible sin número de parte -> `SYS-<id>`;
--   - si el valor calculado ya existe en otro producto -> sufijo `-<id>`.
--
-- Idempotente.
-- =====================================================================

create or replace function public.fn_productos_codigo_barras()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $fn$
declare
  base      text;
  candidate text;
begin
  if new.codigo_barras is not null and btrim(new.codigo_barras) <> '' then
    new.codigo_barras := btrim(new.codigo_barras);
    return new;
  end if;

  -- Componente: su código de barras es su serie / código interno; lo asigna
  -- set_producto_unidad tras guardar la unidad física.
  if coalesce(new.es_trazable, false) then
    new.codigo_barras := null;
    return new;
  end if;

  -- Consumible: el número de parte tal cual (espacios -> `_`), sin prefijo.
  if new.no_parte is not null and btrim(new.no_parte) <> '' then
    base      := regexp_replace(btrim(new.no_parte), '\s+', '_', 'g');
    candidate := base;
    if exists (
      select 1 from public.productos p
      where p.codigo_barras = candidate and p.id <> new.id
    ) then
      candidate := base || '-' || new.id::text;
    end if;
  else
    candidate := 'SYS-' || new.id::text;
  end if;

  new.codigo_barras := left(candidate, 100);
  return new;
end $fn$;

-- Backfill: consumibles cuyo código de barras es el `BAR-*` autogenerado
-- (no un valor propio del usuario) -> pasa a ser el número de parte.
update public.productos p
   set codigo_barras = regexp_replace(btrim(p.no_parte), '\s+', '_', 'g'),
       updated_at = now()
 where coalesce(p.es_trazable, false) = false
   and p.no_parte is not null and btrim(p.no_parte) <> ''
   and p.codigo_barras in (
     'BAR-' || regexp_replace(btrim(p.no_parte), '\s+', '_', 'g'),
     'BAR-' || regexp_replace(btrim(p.no_parte), '\s+', '_', 'g') || '-' || p.id::text
   );
