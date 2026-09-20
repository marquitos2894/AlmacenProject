-- =====================================================================
-- 0048 — Código interno: guion entre el año y el correlativo, y correlativo
-- sin límite de dígitos.
--
-- Correcciones al patrón de la migración 0045:
--
-- 1) Faltaba el guion: el patrón es TCH-AÑO-NUMERACION (TCH-026-1), no
--    TCH-AÑONUMERACION (TCH-0261).
--
-- 2) El correlativo se generaba con lpad(v_num::text, 3, '0'), que TRUNCA por
--    la izquierda en vez de solo rellenar cuando el número ya tiene más de 3
--    dígitos (lpad('1000', 3, '0') da '100', no '1000' — se probó en vivo).
--    Pasado el código 999 del año, esto habría generado correlativos
--    repetidos. Ahora se rellena con ceros solo hasta 3 dígitos y, si el
--    número ya los tiene o más, se deja tal cual: 1 -> '001', 999 -> '999',
--    1000 -> '1000', 12345 -> '12345'. Sin tope.
--
-- Backfill: TCH-026001 -> TCH-026-001.
-- =====================================================================

update public.producto_unidad
   set codigo_interno = 'TCH-026-001', updated_at = now()
 where codigo_interno = 'TCH-026001';

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
  v_num_txt       text;
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
  -- unidad y, si tampoco hay, se genera con el patrón TCH-AÑO-NUMERACION (año
  -- corto de 3 dígitos + guion + correlativo del año, sin límite de dígitos).
  v_cod := nullif(btrim(coalesce(p_codigo_interno, '')), '');
  if v_cod is null then
    v_cod := nullif(btrim(coalesce(v_cod_existente, '')), '');
  end if;
  if v_cod is null then
    v_anio     := lpad((extract(year from current_date)::int % 1000)::text, 3, '0');
    v_seq_name := 'producto_unidad_codigo_interno_seq_' || v_anio;
    execute format('create sequence if not exists public.%I', v_seq_name);
    v_num     := nextval(format('public.%I', v_seq_name)::regclass);
    v_num_txt := v_num::text;
    -- Solo rellena hasta 3 dígitos; nunca recorta uno que ya tenga más.
    if length(v_num_txt) < 3 then
      v_num_txt := lpad(v_num_txt, 3, '0');
    end if;
    v_cod := 'TCH-' || v_anio || '-' || v_num_txt;
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
