-- =====================================================================
-- 0055 — El código interno nunca se repite, ni con la secuencia "adelantada".
--
-- Motivo: tras el arreglo de permisos (0054) se reinició a mano la secuencia
-- `producto_unidad_codigo_interno_seq_026` a 1 para que el equipo pudiera
-- retomar la numeración en TCH-026-002. Pero entre medio ya se había creado
-- un componente real con TCH-026-006 (id de producto 1138) que ese reinicio
-- no tuvo en cuenta: la secuencia iba a volver a pasar por 6 y, como
-- `set_producto_unidad` solo hacía `nextval()` sin comprobar si ese código ya
-- existía, habría generado un DUPLICADO silencioso (no hay índice único que
-- lo impida hoy).
--
-- Dos cambios, cinturón y tirantes:
--
-- 1) `set_producto_unidad` ahora repite `nextval()` hasta encontrar un
--    número cuyo código TCH-<año>-<n> todavía NO exista en producto_unidad.
--    Así, un reinicio manual de la secuencia (o cualquier otro desajuste)
--    nunca puede producir un código repetido: si cae en uno ya usado, salta
--    al siguiente automáticamente.
-- 2) Índice único sobre `producto_unidad.codigo_interno` (ignorando nulos):
--    red de seguridad a nivel de base de datos, por si algún día se inserta
--    un código por otra vía.
-- =====================================================================

create unique index if not exists uq_producto_unidad_codigo_interno
  on public.producto_unidad (codigo_interno)
  where codigo_interno is not null;

create or replace function public.set_producto_unidad(
  p_producto_id bigint,
  p_modelo character varying,
  p_no_serie character varying,
  p_codigo_interno character varying
) returns bigint
language plpgsql
security definer
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
  if not public.puede_editar() then
    raise exception 'No tienes permiso para editar.';
  end if;

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

  v_cod := nullif(btrim(coalesce(p_codigo_interno, '')), '');
  if v_cod is null then
    v_cod := nullif(btrim(coalesce(v_cod_existente, '')), '');
  end if;
  if v_cod is null then
    v_anio     := lpad((extract(year from current_date)::int % 1000)::text, 3, '0');
    v_seq_name := 'producto_unidad_codigo_interno_seq_' || v_anio;
    execute format('create sequence if not exists public.%I', v_seq_name);
    -- Salta cualquier número cuyo código ya exista (p. ej. tras reiniciar la
    -- secuencia a mano): nunca genera un código repetido.
    loop
      v_num     := nextval(format('public.%I', v_seq_name)::regclass);
      v_num_txt := v_num::text;
      if length(v_num_txt) < 3 then
        v_num_txt := lpad(v_num_txt, 3, '0');
      end if;
      v_cod := 'TCH-' || v_anio || '-' || v_num_txt;
      exit when not exists (
        select 1 from public.producto_unidad pu where pu.codigo_interno = v_cod
      );
    end loop;
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
