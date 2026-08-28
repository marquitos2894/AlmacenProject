-- =====================================================================
-- 0014 — Descripciones legibles, referencias en el movimiento y búsqueda
--        ampliada del modal de productos.
--
-- Idempotente: puede re-ejecutarse en el SQL Editor de Supabase.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. producto_unidad.descripcion
--    Derivada: "modelo/no_serie", o "modelo/codigo_interno" si no hay serie.
--    Al ser columna generada nunca se desincroniza de sus partes; a cambio
--    es de solo lectura (no se captura a mano).
--    Se usa `||` explícito porque concat_ws no es inmutable, y una columna
--    generada solo admite expresiones inmutables.
-- ---------------------------------------------------------------------

alter table public.producto_unidad drop column if exists descripcion;
alter table public.producto_unidad
  add column descripcion text
  generated always as (
    case
      when nullif(btrim(modelo::text), '') is null
        then coalesce(nullif(btrim(no_serie::text), ''), nullif(btrim(codigo_interno::text), ''))
      when coalesce(nullif(btrim(no_serie::text), ''), nullif(btrim(codigo_interno::text), '')) is null
        then nullif(btrim(modelo::text), '')
      else nullif(btrim(modelo::text), '') || '/' ||
           coalesce(nullif(btrim(no_serie::text), ''), nullif(btrim(codigo_interno::text), ''))
    end
  ) stored;

-- ---------------------------------------------------------------------
-- 2. equipos.descripcion — texto libre, lo captura el usuario.
-- ---------------------------------------------------------------------

alter table public.equipos add column if not exists descripcion text;

-- ---------------------------------------------------------------------
-- 3. movimientos: a qué unidad y a qué equipo se refiere el ticket.
--    on delete set null: dar de baja un equipo no debe borrar el histórico.
-- ---------------------------------------------------------------------

alter table public.movimientos
  add column if not exists id_producto_unidad bigint references public.producto_unidad(id) on delete set null,
  add column if not exists id_equipo          bigint references public.equipos(id) on delete set null;

create index if not exists idx_movimientos_producto_unidad on public.movimientos (id_producto_unidad);
create index if not exists idx_movimientos_equipo          on public.movimientos (id_equipo);

-- ---------------------------------------------------------------------
-- 4. Búsqueda del modal "Agregar producto": no_parte, nombre, serie,
--    código de barras y código interno. Serie y código interno viven en
--    producto_unidad, así que se traen unidos.
-- ---------------------------------------------------------------------

create or replace view public.vw_productos_busqueda
with (security_invoker = true) as
select
  p.id,
  p.nombre,
  p.no_parte,
  p.marca,
  p.codigo_barras,
  p.es_trazable,
  p.activo,
  u.no_serie       as no_serie,
  u.codigo_interno as codigo_interno,
  u.modelo         as modelo,
  u.descripcion    as unidad_descripcion
from public.productos p
left join lateral (
  select pu.* from public.producto_unidad pu
   where pu.producto_id = p.id and pu.activo
   order by pu.id
   limit 1
) u on true;

-- ---------------------------------------------------------------------
-- 5. Listas para los selectores de unidad y equipo en Movimientos
-- ---------------------------------------------------------------------

create or replace view public.vw_equipos_lista
with (security_invoker = true) as
select
  e.id, e.modelo, e.marca, e.no_serie, e.unidad_actual, e.estado_actual,
  e.descripcion, e.activo,
  concat_ws('/', nullif(btrim(e.modelo), ''), nullif(btrim(e.no_serie), '')) as etiqueta
from public.equipos e
where e.activo;

create or replace view public.vw_producto_unidad_lista
with (security_invoker = true) as
select
  u.id, u.producto_id, u.modelo, u.no_serie, u.codigo_interno, u.marca,
  u.descripcion, u.estado_id, u.activo,
  p.nombre   as producto_nombre,
  p.no_parte as no_parte,
  e.nombre   as estado_nombre
from public.producto_unidad u
join public.productos p on p.id = u.producto_id
left join public.estados e on e.id = u.estado_id
where u.activo;

grant select on public.vw_productos_busqueda    to authenticated;
grant select on public.vw_equipos_lista         to authenticated;
grant select on public.vw_producto_unidad_lista to authenticated;
