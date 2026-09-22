-- =====================================================================
-- 0054 — set_producto_unidad: permission denied for schema public.
--
-- La función generaba el código interno con `create sequence if not exists
-- public.<nombre>` (una secuencia por año, creada la primera vez que hace
-- falta ese año). Es SECURITY INVOKER (el valor por defecto): corre con los
-- permisos del usuario que llama, y el rol `authenticated` tiene USAGE sobre
-- el esquema `public` pero NO tiene CREATE. Postgres exige el privilegio
-- CREATE para `CREATE SEQUENCE IF NOT EXISTS` aunque la secuencia YA exista
-- (el chequeo de permiso es previo al de existencia), así que en cuanto
-- tocaba crear la secuencia del año la función fallaba con "permission
-- denied for schema public" — y como el alta del producto y la llamada a
-- esta función van en dos pasos separados desde el frontend, el producto
-- quedaba creado pero sin su unidad física: sin serie, sin modelo, sin
-- código interno.
--
-- Se marca la función SECURITY DEFINER (corre con los permisos de su dueño,
-- que sí puede crear objetos en `public`). Para no perder por eso el control
-- de permisos que antes daba RLS (`producto_unidad_insert`/`_update` exigen
-- `puede_editar()`, y RLS no se aplica al dueño de la tabla), se agrega el
-- mismo chequeo explícito al principio de la función.
-- =====================================================================

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
  -- SECURITY DEFINER se salta la RLS de producto_unidad (no se aplica al
  -- dueño de la tabla): se repite aquí a mano la misma regla que exigían
  -- las políticas producto_unidad_insert/_update.
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
    v_num     := nextval(format('public.%I', v_seq_name)::regclass);
    v_num_txt := v_num::text;
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

-- --------------------------------------------------------------- Backfill
-- Componentes activos sin unidad física (el fallo descrito arriba): se les
-- genera su código interno ahora. El modelo/serie que el usuario haya
-- tecleado en ese intento se perdió (la llamada nunca llegó a guardarse), así
-- que quedan en blanco — se pueden completar editando el producto.
do $$
declare
  v_producto record;
begin
  for v_producto in
    select p.id
      from public.productos p
     where p.activo
       and p.es_trazable
       and not exists (
         select 1 from public.producto_unidad pu
          where pu.producto_id = p.id and pu.activo
       )
  loop
    perform public.set_producto_unidad(v_producto.id, null, null, null);
  end loop;
end $$;
