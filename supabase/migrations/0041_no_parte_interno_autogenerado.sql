-- =====================================================================
-- 0041 — Consumible sin número de parte -> `INT-XXXXX` autogenerado.
--
-- En este sistema el `no_parte` de un consumible es su identidad, su valor de
-- código de barras (mig. 0040) y la clave por la que "Stock por almacén"
-- agrupa. Un consumible sin `no_parte` daba una etiqueta `SYS-<id>` ilegible y,
-- peor, todos los consumibles sin `no_parte` de un almacén colapsaban en una
-- sola fila en Stock.
--
-- Ahora, igual que el `TCH-XXXXX` del código interno de componentes (mig. 0038),
-- un consumible que se guarde sin número de parte recibe `INT-` + secuencia.
-- Además `vw_stock_agrupado` deja de juntar filas sin `no_parte` (agrupa por
-- `producto_id` en ese caso), por si entran nulos por importación.
--
-- Idempotente.
-- =====================================================================

create sequence if not exists public.productos_no_parte_interno_seq;

-- 1) Trigger de productos: consumible sin número de parte -> INT-XXXXX, y a
--    partir de ahí el código de barras (rama de consumible) ya nunca queda vacío.
create or replace function public.fn_productos_codigo_barras()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $fn$
declare
  base      text;
  candidate text;
begin
  -- Consumible sin número de parte: se le asigna uno interno.
  if not coalesce(new.es_trazable, false)
     and (new.no_parte is null or btrim(new.no_parte) = '') then
    new.no_parte := 'INT-' || lpad(
      nextval('public.productos_no_parte_interno_seq')::text, 5, '0');
  end if;

  -- Valor de código de barras escrito por el usuario: se respeta.
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
    candidate := 'SYS-' || new.id::text;  -- salvaguarda: ya inalcanzable
  end if;

  new.codigo_barras := left(candidate, 100);
  return new;
end $fn$;

-- 2) vw_stock_agrupado: no juntar filas sin `no_parte` (fallback a producto_id).
create or replace view public.vw_stock_agrupado
with (security_invoker = true) as
select pa.almacen_id,
       a.nombre as almacen_nombre,
       p.no_parte,
       min(p.nombre::text) as producto_nombre,
       sum(pa.stock_actual) as stock_total,
       count(distinct pa.producto_id) as total_series,
       count(*) as total_existencias,
       count(distinct pa.ubicacion_norm) as total_ubicaciones,
       min(p.marca::text) as marca,
       bool_or(pa.es_trazable) as es_trazable
  from public.producto_almacen pa
  join public.productos p on p.id = pa.producto_id
  join public.almacenes a on a.id = pa.almacen_id
 where pa.activo = true
 group by pa.almacen_id, a.nombre, p.no_parte,
          coalesce(nullif(btrim(p.no_parte), ''), 'prod:' || pa.producto_id::text);

grant select on public.vw_stock_agrupado to authenticated;

-- 3) Backfill: consumibles sin número de parte -> INT-XXXXX (hoy no afecta filas).
update public.productos p
   set no_parte = 'INT-' || lpad(
         nextval('public.productos_no_parte_interno_seq')::text, 5, '0'),
       codigo_barras = null,   -- el trigger lo regenera desde el nuevo no_parte
       updated_at = now()
 where coalesce(p.es_trazable, false) = false
   and (p.no_parte is null or btrim(p.no_parte) = '');
