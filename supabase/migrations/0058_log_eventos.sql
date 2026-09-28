-- =====================================================================
-- 0058 — Log de eventos (bitácora) por trigger
--
-- Registra quién hizo qué y cuándo, sin depender del frontend: un trigger
-- genérico (fn_log_evento) escribe en log_eventos el usuario de la sesión
-- (auth.uid()), la tabla/registro/datos cambiados y una reseña legible.
--
-- Alcance: eventos de negocio. Cabeceras de movimientos (alta y anulación)
-- y transferencias, altas/ediciones/bajas de catálogos y usuarios, y cambios
-- de estado/ubicación/activo de una existencia. NO se registran renglones de
-- detalle ni ajustes de stock (ya quedan en movimientos/transferencias).
--
-- Seguridad: lectura para todo autenticado; nadie escribe el log desde la
-- API (sin políticas de escritura + revoke). Solo el trigger, SECURITY
-- DEFINER, inserta.
-- =====================================================================

create table if not exists public.log_eventos (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  txid        bigint not null default txid_current(), -- agrupa eventos de la misma transacción
  usuario_id  bigint,          -- sin FK: el log no depende de la vida del usuario
  usuario     text,            -- snapshot del nombre/email; null = sin sesión (SQL)
  tabla       text not null,
  entidad     text not null,
  operacion   text not null,   -- INSERT / UPDATE / DELETE
  accion      text not null,   -- alta / edición / baja / reactivación / anulación / eliminación
  registro_id bigint,
  resena      text not null,
  cambios     jsonb            -- UPDATE: {col: [antes, después]}; INSERT/DELETE: la fila
);

alter table public.log_eventos enable row level security;
drop policy if exists log_eventos_select on public.log_eventos;
create policy log_eventos_select on public.log_eventos
  for select to authenticated using (true);
revoke insert, update, delete, truncate on public.log_eventos from anon, authenticated;

-- ------------------------------------------------------------ Trigger
create or replace function public.fn_log_evento()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_new     jsonb;
  v_old     jsonb;
  v_row     jsonb;
  v_cambios jsonb;
  v_accion  text;
  v_entidad text;
  v_nombre  text;
  v_resena  text;
  v_uid     bigint;
  v_usuario text;
begin
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  v_row := coalesce(v_new, v_old);

  -- UPDATE: solo lo que cambió, sin columnas técnicas o derivadas por otros
  -- triggers. Si no queda nada (p. ej. solo cambió estado_actual) no se registra.
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(k, jsonb_build_array(v_old -> k, v_new -> k))
      into v_cambios
      from jsonb_object_keys(v_new) as k
     where k <> all (array['updated_at', 'created_at', 'ubicacion_norm', 'codigo_control_norm',
                           'estado_actual', 'ubicacion_actual', 'unidad_actual'])
       and (v_old -> k) is distinct from (v_new -> k);
    if v_cambios is null then
      return null;
    end if;
  end if;

  v_accion := case
    when tg_op = 'INSERT' then 'alta'
    when tg_op = 'DELETE' then 'eliminación'
    when v_cambios ? 'anulado' and (v_new ->> 'anulado')::boolean then 'anulación'
    when v_cambios ? 'activo' then
      case when (v_new ->> 'activo')::boolean then 'reactivación' else 'baja' end
    else 'edición'
  end;

  v_entidad := case tg_table_name
    when 'productos'               then 'Producto'
    when 'producto_unidad'         then 'Unidad de componente'
    when 'almacenes'               then 'Almacén'
    when 'proveedores'             then 'Proveedor'
    when 'unidades_medida'         then 'Unidad de medida'
    when 'estados'                 then 'Estado'
    when 'equipos'                 then 'Equipo'
    when 'tipos_equipo'            then 'Tipo de equipo'
    when 'tipos_producto'          then 'Tipo de producto'
    when 'unidad_operativa'        then 'Establecimiento'
    when 'equipo_unidad_operativa' then 'Asignación de equipo'
    when 'usuarios'                then 'Usuario'
    when 'movimientos'             then 'Movimiento'
    when 'transferencias'          then 'Transferencia'
    when 'producto_almacen'        then 'Existencia'
    else tg_table_name
  end;

  v_nombre := coalesce(
    case when tg_table_name = 'usuarios' then v_row ->> 'email' end,
    v_row ->> 'folio', v_row ->> 'nombre', v_row ->> 'razon_social', v_row ->> 'codigo',
    v_row ->> 'no_serie', v_row ->> 'email', v_row ->> 'modelo', '#' || (v_row ->> 'id'));

  -- Reseñas específicas; el resto usa la genérica de abajo.
  if tg_table_name = 'movimientos' then
    if v_accion = 'anulación' then
      v_resena := format('Movimiento %s anulado. Motivo: %s', v_nombre, coalesce(v_row ->> 'anulado_motivo', '—'));
    elsif tg_op = 'INSERT' then
      v_resena := format('Movimiento %s registrado: %s en %s', v_nombre,
        case when (v_row ->> 'es_stock_inicial')::boolean then 'stock inicial' else v_row ->> 'tipo_movimiento' end,
        coalesce((select nombre from almacenes where id = (v_row ->> 'almacen_id')::bigint), '—'));
    end if;

  elsif tg_table_name = 'transferencias' then
    v_resena := format('Transferencia %s registrada: %s → %s', v_nombre,
      coalesce((select nombre from almacenes where id = (v_row ->> 'almacen_origen_id')::bigint), '—'),
      coalesce((select nombre from almacenes where id = (v_row ->> 'almacen_destino_id')::bigint), '—'));

  elsif tg_table_name = 'equipo_unidad_operativa' then
    v_resena := format('%s de asignación: equipo «%s» en «%s»', initcap(v_accion),
      coalesce((select coalesce(e.codigo, e.modelo) from equipos e where e.id = (v_row ->> 'equipo_id')::bigint), '—'),
      coalesce((select u.nombre from unidad_operativa u where u.id = (v_row ->> 'unidad_operativa_id')::bigint), '—'));
    if v_accion = 'edición' then
      v_resena := v_resena || ': ' || (select string_agg(replace(k, '_', ' '), ', ' order by k) from jsonb_object_keys(v_cambios) as k);
    end if;

  elsif tg_table_name = 'producto_almacen' then
    v_resena := format('Existencia de «%s» en «%s»: %s',
      coalesce((select nombre from productos where id = (v_row ->> 'producto_id')::bigint), '—'),
      coalesce((select nombre from almacenes where id = (v_row ->> 'almacen_id')::bigint), '—'),
      concat_ws('; ',
        case when v_cambios ? 'almacen_id' then format('almacén %s → %s',
          coalesce((select nombre from almacenes where id = (v_old ->> 'almacen_id')::bigint), '—'),
          coalesce((select nombre from almacenes where id = (v_new ->> 'almacen_id')::bigint), '—')) end,
        case when v_cambios ? 'estado_id' then format('estado %s → %s',
          coalesce((select nombre from estados where id = (v_old ->> 'estado_id')::bigint), 'sin estado'),
          coalesce((select nombre from estados where id = (v_new ->> 'estado_id')::bigint), 'sin estado')) end,
        case when v_cambios ? 'ubicacion' then format('ubicación %s → %s',
          coalesce(v_old ->> 'ubicacion', '—'), coalesce(v_new ->> 'ubicacion', '—')) end,
        case v_accion when 'baja' then 'desactivada' when 'reactivación' then 'reactivada' end));
  end if;

  if v_resena is null then
    v_resena := format('%s de %s «%s»', initcap(v_accion), lower(v_entidad), v_nombre);
    if v_accion = 'edición' then
      v_resena := v_resena || ': ' || (select string_agg(replace(k, '_', ' '), ', ' order by k) from jsonb_object_keys(v_cambios) as k);
    end if;
  end if;

  -- Usuario de la sesión (JWT). Sin sesión (SQL Editor) queda null.
  select u.id, coalesce(nullif(trim(coalesce(u.nombre, '') || ' ' || coalesce(u.apellido, '')), ''), u.email)
    into v_uid, v_usuario
    from usuarios u
   where u.auth_uid = auth.uid();
  v_usuario := coalesce(v_usuario, auth.jwt() ->> 'email');

  insert into log_eventos (usuario_id, usuario, tabla, entidad, operacion, accion, registro_id, resena, cambios)
  values (v_uid, v_usuario, tg_table_name, v_entidad, tg_op, v_accion, (v_row ->> 'id')::bigint, v_resena,
          case when tg_op = 'UPDATE' then v_cambios else v_row end);

  return null;
end $$;

-- Un trigger no comprueba EXECUTE al dispararse: se quita para que la función
-- no quede invocable desde la API.
revoke execute on function public.fn_log_evento() from public, anon, authenticated;

-- ----------------------------------------------------------- Triggers
do $$
declare
  t text;
begin
  foreach t in array array[
    'productos', 'producto_unidad', 'almacenes', 'proveedores', 'unidades_medida', 'estados',
    'equipos', 'tipos_equipo', 'tipos_producto', 'unidad_operativa', 'equipo_unidad_operativa', 'usuarios'
  ] loop
    execute format('drop trigger if exists trg_log_evento on public.%I', t);
    execute format(
      'create trigger trg_log_evento after insert or update or delete on public.%I
         for each row execute function public.fn_log_evento()', t);
  end loop;
end $$;

drop trigger if exists trg_log_evento on public.movimientos;
create trigger trg_log_evento after insert or update on public.movimientos
  for each row execute function public.fn_log_evento();

drop trigger if exists trg_log_evento on public.transferencias;
create trigger trg_log_evento after insert on public.transferencias
  for each row execute function public.fn_log_evento();

-- Existencias: solo cambios de estado/ubicación/activo SIN tocar el stock
-- (cambiar_estado_existencia, fusiones, reubicaciones). Los ajustes de stock
-- de cada movimiento no se registran aquí.
drop trigger if exists trg_log_evento on public.producto_almacen;
create trigger trg_log_evento after update on public.producto_almacen
  for each row
  when (old.stock_actual is not distinct from new.stock_actual
        and (old.estado_id is distinct from new.estado_id
             or old.ubicacion is distinct from new.ubicacion
             or old.activo is distinct from new.activo))
  execute function public.fn_log_evento();
