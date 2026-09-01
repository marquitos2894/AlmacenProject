-- =====================================================================
-- 0033 — Una transferencia total desactiva la existencia de origen.
--
-- `registrar_transferencia` descontaba del origen y sumaba al destino, pero si
-- la transferencia se llevaba TODO el stock del renglón, la existencia de
-- origen quedaba activa en 0 — un hueco vacío. Ahora, cuando el origen queda
-- en 0, se desactiva: el producto solo permanece en el almacén de destino.
--
-- Los trazables ya se transfieren mudando la misma fila de almacén (no dejan
-- rastro en el origen); esto solo afecta a los consumibles.
-- Idempotente.
-- =====================================================================

create or replace function public.registrar_transferencia(
  p_almacen_origen_id bigint,
  p_almacen_destino_id bigint,
  p_fecha date,
  p_motivo character varying,
  p_observaciones text,
  p_usuario_id bigint,
  p_items jsonb
) returns public.transferencias
language plpgsql
set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_t           public.transferencias;
  v_item        jsonb;
  v_pa_o_id     bigint;
  v_producto_id bigint;
  v_cantidad    numeric;
  v_ubic_dest   varchar;
  v_pa_o        public.producto_almacen;
  v_pa_d        public.producto_almacen;
  v_estado_id   bigint;
  v_nombre      text;
  v_traz        boolean;
  v_nuevo_o     numeric;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La transferencia no tiene productos.';
  end if;

  if p_almacen_origen_id is null or p_almacen_destino_id is null then
    raise exception 'Falta el almacén de origen o el de destino.';
  end if;

  if p_almacen_origen_id = p_almacen_destino_id then
    raise exception 'El almacén de origen y el de destino deben ser distintos.';
  end if;

  insert into public.transferencias
    (almacen_origen_id, almacen_destino_id, fecha, motivo, observaciones, usuario_id)
  values
    (p_almacen_origen_id, p_almacen_destino_id, coalesce(p_fecha, current_date),
     p_motivo, p_observaciones, p_usuario_id)
  returning * into v_t;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_pa_o_id     := nullif(v_item ->> 'producto_almacen_id_origen', '')::bigint;
    v_producto_id := (v_item ->> 'producto_id')::bigint;
    v_cantidad    := (v_item ->> 'cantidad')::numeric;
    v_ubic_dest   := nullif(btrim(coalesce(v_item ->> 'ubicacion_destino', '')), '');

    if v_cantidad is null or v_cantidad <= 0 then
      raise exception 'La cantidad debe ser mayor que cero.';
    end if;

    if v_pa_o_id is null then
      raise exception 'Falta la existencia de origen en un renglón.';
    end if;

    select * into v_pa_o from public.producto_almacen where id = v_pa_o_id;
    if not found or not v_pa_o.activo then
      raise exception 'La existencia de origen indicada no existe o está inactiva.';
    end if;
    if v_pa_o.almacen_id <> p_almacen_origen_id then
      raise exception 'La existencia de origen no pertenece al almacén de origen.';
    end if;
    if v_producto_id is not null and v_pa_o.producto_id <> v_producto_id then
      raise exception 'La existencia de origen no corresponde al producto indicado.';
    end if;
    v_producto_id := v_pa_o.producto_id;

    select nombre, coalesce(es_trazable, false)
      into v_nombre, v_traz
      from public.productos
     where id = v_producto_id;

    v_estado_id := v_pa_o.estado_id;
    v_ubic_dest := coalesce(v_ubic_dest, v_pa_o.ubicacion);

    if v_traz then
      if v_cantidad <> coalesce(v_pa_o.stock_actual, 0) then
        raise exception
          'El componente trazable "%" se transfiere completo (stock %); no admite cantidades parciales.',
          coalesce(v_nombre, v_producto_id::text), coalesce(v_pa_o.stock_actual, 0);
      end if;

      update public.producto_almacen
         set almacen_id = p_almacen_destino_id,
             ubicacion  = v_ubic_dest,
             updated_at = now()
       where id = v_pa_o.id
      returning * into v_pa_d;

    else
      v_nuevo_o := coalesce(v_pa_o.stock_actual, 0) - v_cantidad;
      if v_nuevo_o < 0 then
        raise exception
          'Stock insuficiente para "%": disponible %, solicitado %.',
          coalesce(v_nombre, v_producto_id::text), coalesce(v_pa_o.stock_actual, 0), v_cantidad;
      end if;

      update public.producto_almacen
         set stock_actual = v_nuevo_o, updated_at = now()
       where id = v_pa_o.id;

      -- Transferencia total: el origen queda vacío y se desactiva.
      if v_nuevo_o = 0 then
        update public.producto_almacen
           set activo = false, updated_at = now()
         where id = v_pa_o.id;
      end if;

      select * into v_pa_d
        from public.producto_almacen
       where producto_id = v_producto_id
         and almacen_id  = p_almacen_destino_id
         and activo
         and estado_id is not distinct from v_estado_id
         and ubicacion_norm is not distinct from nullif(upper(btrim(coalesce(v_ubic_dest, ''))), '')
       limit 1;

      if found then
        update public.producto_almacen
           set stock_actual = coalesce(stock_actual, 0) + v_cantidad,
               activo = true, updated_at = now()
         where id = v_pa_d.id
        returning * into v_pa_d;
      else
        insert into public.producto_almacen
          (producto_id, almacen_id, stock_actual, estado_id, ubicacion)
        values
          (v_producto_id, p_almacen_destino_id, v_cantidad, v_estado_id, v_ubic_dest)
        returning * into v_pa_d;
      end if;
    end if;

    insert into public.transferencia_detalle
      (transferencia_id, producto_id, cantidad, estado_id,
       ubicacion_origen, ubicacion_destino,
       producto_almacen_id_origen, producto_almacen_id_destino)
    values
      (v_t.id, v_producto_id, v_cantidad, v_estado_id,
       v_pa_o.ubicacion, v_ubic_dest,
       v_pa_o.id, v_pa_d.id);
  end loop;

  return v_t;
end $fn$;

grant execute on function public.registrar_transferencia(
  bigint, bigint, date, character varying, text, bigint, jsonb
) to authenticated;

-- --------------------------------------------------------------- Backfill
-- Existencias de consumible que quedaron vacías por una transferencia previa.
update public.producto_almacen pa
   set activo = false, updated_at = now()
 where pa.activo
   and pa.es_trazable = false
   and coalesce(pa.stock_actual, 0) = 0
   and exists (
     select 1 from public.transferencia_detalle td
      where td.producto_almacen_id_origen = pa.id
   );
