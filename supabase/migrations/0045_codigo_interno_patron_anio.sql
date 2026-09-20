-- =====================================================================
-- 0045 — Código interno con año: TCH-AAA### (año corto + correlativo del año).
--
-- El patrón deja la secuencia global TCH-00001 y pasa a incluir el año en que
-- se generó, con un correlativo de 3 dígitos que arranca en 1 cada año:
-- TCH-026001 = "TCH-" + año 2026 (026) + primer código del año (001).
-- Cada año usa su propia secuencia (`producto_unidad_codigo_interno_seq_AAA`),
-- creada sola la primera vez que se genera un código ese año, así que el
-- correlativo reinicia solo sin mantenimiento manual.
--
-- Backfill: el único código existente con el patrón viejo (TCH-00001, dado de
-- alta en 2026) pasa a TCH-026001, dejando la secuencia del año 026 lista
-- para seguir desde el 2.
--
-- Idempotente.
-- =====================================================================

create sequence if not exists public.producto_unidad_codigo_interno_seq_026;
select setval('public.producto_unidad_codigo_interno_seq_026', 1, true);

update public.producto_unidad
   set codigo_interno = 'TCH-026001', updated_at = now()
 where codigo_interno = 'TCH-00001';

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
  v_anio          text;
  v_seq_name      text;
  v_num           bigint;
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
  -- unidad y, si tampoco hay, se genera con el patrón TCH-AAA### (año corto +
  -- correlativo de 3 dígitos que arranca en 1 cada año).
  v_cod := nullif(btrim(coalesce(p_codigo_interno, '')), '');
  if v_cod is null then
    v_cod := nullif(btrim(coalesce(v_cod_existente, '')), '');
  end if;
  if v_cod is null then
    v_anio     := lpad((extract(year from current_date)::int % 1000)::text, 3, '0');
    v_seq_name := 'producto_unidad_codigo_interno_seq_' || v_anio;
    execute format('create sequence if not exists public.%I', v_seq_name);
    v_num := nextval(format('public.%I', v_seq_name)::regclass);
    v_cod := 'TCH-' || v_anio || lpad(v_num::text, 3, '0');
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
