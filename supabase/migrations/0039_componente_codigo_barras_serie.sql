-- =====================================================================
-- 0039 — El código de barras de un componente es su serie (o código interno).
--
-- Antes: el componente recibía `codigo_barras = 'BAR-' || no_parte`, que dos
-- componentes del mismo número de parte compartían (con sufijo `-id`). La
-- etiqueta, además, se generaba aparte desde la serie.
--
-- Ahora el `codigo_barras` del componente ES su serie y, si no tiene serie,
-- su código interno (TCH-XXXXX). La etiqueta lee siempre `codigo_barras`.
--   - El trigger de `productos` deja de auto-generarlo para trazables.
--   - `set_producto_unidad` lo sincroniza tras guardar la unidad física.
--   - Un valor propio escrito por el usuario se respeta.
--
-- Los consumibles no cambian.
-- Idempotente.
-- =====================================================================

-- 1) Trigger: para trazables sin código propio, se deja vacío (lo pone
--    set_producto_unidad); para consumibles, sigue generándose del no. de parte.
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

  if new.no_parte is not null and btrim(new.no_parte) <> '' then
    base      := 'BAR-' || regexp_replace(btrim(new.no_parte), '\s+', '_', 'g');
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

-- 2) set_producto_unidad sincroniza productos.codigo_barras del componente.
create or replace function public.set_producto_unidad(
  p_producto_id bigint,
  p_modelo character varying,
  p_no_serie character varying,
  p_codigo_interno character varying
) returns bigint
language plpgsql
set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_traz            boolean;
  v_marca           character varying;
  v_id              bigint;
  v_cod_existente   character varying;
  v_serie_existente character varying;
  v_cod             character varying;
  v_serie           character varying;
  v_cb_actual       character varying;
begin
  if p_producto_id is null then
    raise exception 'Falta el producto.';
  end if;

  select coalesce(es_trazable, false), marca
    into v_traz, v_marca
    from public.productos
   where id = p_producto_id;

  if not found then
    raise exception 'El producto % no existe.', p_producto_id;
  end if;

  if not v_traz then
    update public.producto_unidad
       set activo = false, updated_at = now()
     where producto_id = p_producto_id and activo;
    return null;
  end if;

  select id, codigo_interno, no_serie
    into v_id, v_cod_existente, v_serie_existente
    from public.producto_unidad
   where producto_id = p_producto_id and activo
   order by id
   limit 1;

  v_serie := nullif(btrim(coalesce(p_no_serie, '')), '');

  -- Código interno: el que llega; si viene vacío se conserva el que ya tenía y,
  -- si tampoco hay, se genera con el patrón TCH-XXXXX.
  v_cod := nullif(btrim(coalesce(p_codigo_interno, '')), '');
  if v_cod is null then
    v_cod := nullif(btrim(coalesce(v_cod_existente, '')), '');
  end if;
  if v_cod is null then
    v_cod := 'TCH-' || lpad(nextval('public.producto_unidad_codigo_interno_seq')::text, 5, '0');
  end if;

  if v_id is not null then
    update public.producto_unidad
       set modelo         = nullif(btrim(coalesce(p_modelo, '')), ''),
           no_serie       = v_serie,
           codigo_interno = v_cod,
           marca          = v_marca,
           updated_at     = now()
     where id = v_id;
  else
    insert into public.producto_unidad
      (producto_id, modelo, no_serie, codigo_interno, marca)
    values
      (p_producto_id, nullif(btrim(coalesce(p_modelo, '')), ''), v_serie, v_cod, v_marca)
    returning id into v_id;
  end if;

  -- El código de barras del componente es su serie (o su código interno). Se
  -- mantiene sincronizado salvo que el usuario haya escrito uno propio
  -- (distinto de la serie / código interno anteriores).
  select codigo_barras into v_cb_actual from public.productos where id = p_producto_id;
  if v_cb_actual is null or btrim(v_cb_actual) = ''
     or v_cb_actual = nullif(btrim(coalesce(v_serie_existente, '')), '')
     or v_cb_actual = nullif(btrim(coalesce(v_cod_existente, '')), '') then
    update public.productos
       set codigo_barras = coalesce(v_serie, v_cod), updated_at = now()
     where id = p_producto_id
       and codigo_barras is distinct from coalesce(v_serie, v_cod);
  end if;

  return v_id;
end $fn$;

grant execute on function public.set_producto_unidad(bigint, character varying, character varying, character varying) to authenticated;

-- 3) Backfill: cada componente activo toma como código de barras su serie
--    (o su código interno). Todos los actuales tenían un BAR-* autogenerado.
update public.productos p
   set codigo_barras = coalesce(
         nullif(btrim(pu.no_serie::text), ''),
         nullif(btrim(pu.codigo_interno::text), '')
       ),
       updated_at = now()
  from public.producto_unidad pu
 where pu.producto_id = p.id
   and pu.activo
   and coalesce(p.es_trazable, false)
   and coalesce(
         nullif(btrim(pu.no_serie::text), ''),
         nullif(btrim(pu.codigo_interno::text), '')
       ) is not null
   and p.codigo_barras is distinct from coalesce(
         nullif(btrim(pu.no_serie::text), ''),
         nullif(btrim(pu.codigo_interno::text), '')
       );
