-- =====================================================================
-- 0038 — Código interno autogenerado (patrón TCH-XXXXX) para componentes.
--
-- Al dar de alta un componente sin código interno, `set_producto_unidad` le
-- asigna uno con el patrón TCH- + 5 dígitos de una secuencia. Si el usuario
-- escribe uno, se respeta. Al editar, si el campo llega vacío se conserva el
-- que ya tenía y, si tampoco hay, se genera.
--
-- Idempotente.
-- =====================================================================

create sequence if not exists public.producto_unidad_codigo_interno_seq;

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
  v_traz          boolean;
  v_marca         character varying;
  v_id            bigint;
  v_cod_existente character varying;
  v_cod           character varying;
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

  select id, codigo_interno
    into v_id, v_cod_existente
    from public.producto_unidad
   where producto_id = p_producto_id and activo
   order by id
   limit 1;

  -- Código interno: el que llega; si viene vacío se conserva el que ya tenía la
  -- unidad y, si tampoco hay, se genera con el patrón TCH-XXXXX.
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
           no_serie       = nullif(btrim(coalesce(p_no_serie, '')), ''),
           codigo_interno = v_cod,
           marca          = v_marca,
           updated_at     = now()
     where id = v_id;
  else
    insert into public.producto_unidad
      (producto_id, modelo, no_serie, codigo_interno, marca)
    values
      (p_producto_id,
       nullif(btrim(coalesce(p_modelo, '')), ''),
       nullif(btrim(coalesce(p_no_serie, '')), ''),
       v_cod,
       v_marca)
    returning id into v_id;
  end if;

  return v_id;
end $fn$;

grant execute on function public.set_producto_unidad(bigint, character varying, character varying, character varying) to authenticated;
