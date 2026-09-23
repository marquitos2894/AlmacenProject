-- =====================================================================
-- 0056 — Anular un movimiento (ticket), con reversión retroactiva del stock.
--
-- "Anular" no borra el historial (a diferencia de un `delete`): el
-- movimiento se queda, marcado como anulado, y se revierte su efecto en
-- `producto_almacen`. Puede anular cualquier movimiento, no solo el último
-- sobre esa existencia ("retroactivo"), con dos límites deliberados:
--
--  1) Si revertirlo dejaría el stock en negativo, se rechaza — significa que
--     un movimiento posterior ya consumió lo que este aportaba.
--  2) Un renglón de "Stock Inicial" reemplaza el stock, no lo suma; solo se
--     puede revertir sin ambigüedad si fue el ÚNICO movimiento que tocó esa
--     existencia (no hay "valor de antes" que reconstruir si hay más).
--
-- Fuera de alcance a propósito: no deshace fusiones/consolidaciones de
-- OTRAS existencias del mismo lote (0030/0032/0042) — casos raros; si el
-- estado no es el "simple" esperado, se rechaza en vez de adivinar.
-- =====================================================================

alter table public.movimientos
  add column if not exists anulado boolean not null default false,
  add column if not exists anulado_en timestamptz,
  add column if not exists anulado_motivo text,
  add column if not exists anulado_por bigint references public.usuarios(id);

create or replace function public.anular_movimiento(
  p_movimiento_id bigint,
  p_motivo text default null
) returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_mov        public.movimientos;
  v_usuario_id bigint;
  v_det        record;
  v_pa         public.producto_almacen;
  v_otros      int;
  v_nuevo      numeric;
begin
  if not public.puede_editar() then
    raise exception 'No tienes permiso para editar.';
  end if;

  select * into v_mov from public.movimientos where id = p_movimiento_id for update;
  if not found then
    raise exception 'El movimiento no existe.';
  end if;
  if v_mov.anulado then
    raise exception 'Ese movimiento ya está anulado.';
  end if;

  select u.id into v_usuario_id from public.usuarios u where u.auth_uid = auth.uid();

  for v_det in
    select md.* from public.movimiento_detalle md where md.movimiento_id = p_movimiento_id
  loop
    if v_det.producto_almacen_id is null then
      raise exception 'No se puede anular: un renglón no tiene existencia asociada (movimiento anterior a ese registro).';
    end if;

    select * into v_pa from public.producto_almacen where id = v_det.producto_almacen_id for update;
    if not found then
      raise exception 'La existencia asociada a este movimiento ya no existe.';
    end if;

    if v_mov.es_stock_inicial then
      -- Solo revertible sin ambigüedad si fue el único renglón de esa
      -- existencia: si hay otros, no hay forma de saber qué valor tenía antes.
      select count(*) into v_otros
        from public.movimiento_detalle md2
       where md2.producto_almacen_id = v_pa.id and md2.id <> v_det.id;
      if v_otros > 0 then
        raise exception 'No se puede anular: esa existencia tiene otros movimientos además de este stock inicial.';
      end if;
      update public.producto_almacen
         set stock_actual = 0, activo = false, codigo_control = null, updated_at = now()
       where id = v_pa.id;
    else
      if v_mov.tipo_movimiento = 'salida' then
        v_nuevo := coalesce(v_pa.stock_actual, 0) + v_det.cantidad; -- revertir salida = sumar
      else
        v_nuevo := coalesce(v_pa.stock_actual, 0) - v_det.cantidad; -- revertir entrada = restar
      end if;

      if v_nuevo < 0 then
        raise exception 'No se puede anular: dejaría el stock en negativo (hay movimientos posteriores que ya lo consumieron).';
      end if;

      begin
        update public.producto_almacen
           set stock_actual = v_nuevo,
               -- Trazable: activo sigue el mismo criterio que registrar_movimiento
               -- (siempre atado al stock). Con código de control (trazable o no):
               -- 0050 cierra (activo=false) cualquier existencia con código de
               -- control que llegue a 0, así que reabrir también le toca a
               -- cualquiera de las dos. Consumible SIN código de control: no se
               -- toca (su activo/inactivo depende de fusiones con otras
               -- existencias del mismo producto/ubicación, fuera de alcance aquí).
               activo = case
                 when v_pa.es_trazable or v_det.codigo_control is not null then v_nuevo > 0
                 else activo
               end,
               -- Si el código de control se había borrado al agotarse (0050) y
               -- el renglón guarda su propia copia histórica (0052), se
               -- restaura al volver a haber stock.
               codigo_control = coalesce(codigo_control, case when v_nuevo > 0 then v_det.codigo_control else null end),
               updated_at = now()
         where id = v_pa.id;
      exception when unique_violation then
        -- Reactivar esta existencia (o restaurar su código de control)
        -- choca con OTRA existencia activa del mismo producto/almacén/
        -- estado/ubicación/código de control (uq_producto_almacen_grano):
        -- puede pasar si, mientras esta estuvo cerrada, se registró una
        -- entrada nueva que reusó el mismo código de control.
        raise exception 'No se puede anular: reactivar esta existencia chocaría con otra existencia activa igual (mismo producto, almacén, estado, ubicación y código de control). Revísalo manualmente en Stock por almacén.';
      end;
    end if;
  end loop;

  update public.movimientos
     set anulado = true,
         anulado_en = now(),
         anulado_motivo = nullif(btrim(coalesce(p_motivo, '')), ''),
         anulado_por = v_usuario_id
   where id = p_movimiento_id;
end $fn$;

grant execute on function public.anular_movimiento(bigint, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Vistas: exponer el estado de anulación al frontend.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace view public.vw_movimiento_detalle
with (security_invoker = true) as
select md.id,
       md.movimiento_id,
       md.producto_id,
       md.producto_almacen_id,
       md.cantidad,
       md.estado_id,
       md.ubicacion,
       e.nombre as estado_nombre,
       m.folio,
       m.fecha,
       m.tipo_movimiento,
       m.almacen_id,
       p.nombre as producto_nombre,
       p.no_parte,
       p.codigo_barras,
       u.series as no_serie,
       m.es_stock_inicial,
       m.motivo,
       m.created_at,
       coalesce(p.es_trazable, false) as es_trazable,
       u.codigos_internos as codigo_interno,
       md.codigo_control,
       m.anulado
  from public.movimiento_detalle md
  join public.movimientos m on m.id = md.movimiento_id
  join public.productos p on p.id = md.producto_id
  left join public.estados e on e.id = md.estado_id
  left join lateral (
    select string_agg(s.no_serie, ', '::text order by s.no_serie)             as series,
           string_agg(s.codigo_interno, ', '::text order by s.codigo_interno) as codigos_internos
      from (
        select nullif(btrim(pu.no_serie::text), '')       as no_serie,
               nullif(btrim(pu.codigo_interno::text), '')  as codigo_interno
          from public.producto_unidad pu
         where pu.producto_id = md.producto_id
           and pu.activo
      ) s
  ) u on true;

grant select on public.vw_movimiento_detalle to authenticated;

create or replace view public.vw_movimientos
with (security_invoker = true) as
select m.id,
    m.folio,
    m.fecha,
    m.tipo_movimiento,
    m.es_stock_inicial,
    m.motivo,
    m.observaciones,
    m.almacen_id,
    a.nombre as almacen_nombre,
    m.usuario_id,
    trim(both from ((coalesce(u.nombre, ''::character varying)::text || ' '::text) || coalesce(u.apellido, ''::character varying)::text)) as usuario_nombre,
    m.created_at,
    m.id_producto_unidad,
    m.id_equipo,
    m.id_unidad_operativa,
    m.id_proveedor,
    pu.descripcion as unidad_descripcion,
    pup.nombre as unidad_producto_nombre,
    pu.no_serie as unidad_no_serie,
    pu.codigo_interno as unidad_codigo_interno,
    concat_ws('/'::text, nullif(btrim(eq.modelo::text), ''::text), nullif(btrim(eq.no_serie::text), ''::text)) as equipo_etiqueta,
    eq.marca as equipo_marca,
    eq.descripcion as equipo_descripcion,
    uo.nombre as unidad_operativa_nombre,
    uo.codigo as unidad_operativa_codigo,
    uo.proyecto as unidad_operativa_proyecto,
    uo.ubicacion as unidad_operativa_ubicacion,
    uo.zona as unidad_operativa_zona,
    pr.razon_social as proveedor_razon_social,
    pr.codigo as proveedor_codigo,
    pr.ruc as proveedor_ruc,
    d.total_items,
    d.total_cantidad,
    d.productos_resumen,
    d.busq_no_parte,
    d.busq_nombre,
    d.busq_ubicacion,
    d.estado_ids,
    d.busq_codigo_barras,
    d.no_partes_resumen,
    m.anulado,
    m.anulado_en,
    m.anulado_motivo
   from movimientos m
     join almacenes a on a.id = m.almacen_id
     left join usuarios u on u.id = m.usuario_id
     left join producto_unidad pu on pu.id = m.id_producto_unidad
     left join productos pup on pup.id = pu.producto_id
     left join equipos eq on eq.id = m.id_equipo
     left join unidad_operativa uo on uo.id = m.id_unidad_operativa
     left join proveedores pr on pr.id = m.id_proveedor
     left join lateral ( select count(*) as total_items,
            coalesce(sum(md.cantidad), 0::numeric) as total_cantidad,
            string_agg(distinct p.nombre::text, ', '::text) as productos_resumen,
            string_agg(distinct coalesce(p.no_parte, ''::character varying)::text, ' '::text) as busq_no_parte,
            string_agg(distinct p.nombre::text, ' '::text) as busq_nombre,
            string_agg(distinct coalesce(md.ubicacion, ''::character varying)::text, ' '::text) as busq_ubicacion,
            array_remove(array_agg(distinct md.estado_id), null::bigint) as estado_ids,
            string_agg(distinct coalesce(p.codigo_barras, ''::character varying)::text, ' '::text) as busq_codigo_barras,
            string_agg(distinct p.no_parte::text, ', '::text) as no_partes_resumen
           from movimiento_detalle md
             join productos p on p.id = md.producto_id
          where md.movimiento_id = m.id) d on true;

grant select on public.vw_movimientos to authenticated;
