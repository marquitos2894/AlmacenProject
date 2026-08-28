-- =====================================================================
-- 0013 — Corrige `cambiar_estado_existencia`.
--
-- La 0010 renombró `producto_almacen.es_activo_fijo` a `es_trazable`, pero
-- esta función siguió apuntando al nombre viejo. Al cambiar el estado de una
-- existencia desde Stock por almacén fallaba con:
--   Record "v_pa" has no field "es_activo_fijo"
--
-- El barrido de dependencias de la 0010 buscó `activofijo` (la columna de
-- productos) y no `es_activo_fijo`, así que esta función se coló.
--
-- Idempotente: puede re-ejecutarse en el SQL Editor de Supabase.
-- =====================================================================

create or replace function public.cambiar_estado_existencia(
  p_producto_almacen_id bigint,
  p_estado_id           bigint,
  p_ubicacion           varchar
)
returns public.producto_almacen
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_pa      public.producto_almacen;
  v_destino public.producto_almacen;
  v_ubic    varchar;
begin
  select * into v_pa from public.producto_almacen where id = p_producto_almacen_id;
  if not found then
    raise exception 'La existencia indicada no existe.';
  end if;
  if not v_pa.activo then
    raise exception 'Esa existencia está desactivada.';
  end if;

  v_ubic := nullif(btrim(coalesce(p_ubicacion, '')), '');

  -- Un artículo trazable ocupa una sola existencia: no hay nada que fusionar.
  if v_pa.es_trazable then
    update public.producto_almacen
       set estado_id = p_estado_id, ubicacion = v_ubic, updated_at = now()
     where id = v_pa.id
    returning * into v_pa;
    return v_pa;
  end if;

  -- ¿Ya existe otra existencia con ese estado y esa ubicación? -> fusionar
  select * into v_destino
    from public.producto_almacen
   where producto_id = v_pa.producto_id
     and almacen_id  = v_pa.almacen_id
     and activo
     and id <> v_pa.id
     and estado_id is not distinct from p_estado_id
     and ubicacion_norm is not distinct from nullif(upper(btrim(coalesce(v_ubic, ''))), '')
   limit 1;

  if found then
    update public.producto_almacen
       set stock_actual = coalesce(v_destino.stock_actual, 0) + coalesce(v_pa.stock_actual, 0),
           updated_at = now()
     where id = v_destino.id
    returning * into v_destino;

    -- La de origen se desactiva (nunca se borra: el histórico la referencia)
    update public.producto_almacen
       set activo = false, updated_at = now()
     where id = v_pa.id;

    return v_destino;
  end if;

  update public.producto_almacen
     set estado_id = p_estado_id, ubicacion = v_ubic, updated_at = now()
   where id = v_pa.id
  returning * into v_pa;
  return v_pa;
end $$;

grant execute on function public.cambiar_estado_existencia(bigint, bigint, varchar) to authenticated;
