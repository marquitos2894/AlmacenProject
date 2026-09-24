// Filtro de Componentes (modelo, estado, tipo de producto): estado y lógica
// compartidos entre las tres vistas de Productos → Componentes (Tarjetas,
// Tabla y Dashboard), para que elegir un filtro en una se mantenga al pasar
// a otra en vez de tener tres copias independientes.
import { supabase } from "../supabaseClient.js";
import { el, buildSearchSelect } from "../ui.js";

const norm = (s) => String(s || "").trim();

export const filtrosComponentes = { modelo: "", estado: "", tipo: "" };

export const hayFiltroComponentesActivo = () =>
  !!(filtrosComponentes.modelo || filtrosComponentes.estado || filtrosComponentes.tipo);

// Listas para los combos (modelos/estados en uso + catálogo de tipos). Es una
// consulta liviana sobre todos los componentes activos —Tarjetas/Tabla solo
// traen la página actual, así que los combos no pueden salir de esos datos—.
// El dashboard, que ya trae todas las filas para las gráficas, arma sus
// propias opciones a partir de ellas sin repetir esta consulta.
export async function cargarOpcionesFiltroComponentes() {
  const [componentes, tipos] = await Promise.all([
    supabase.from("vw_productos_trazables").select("modelo, estado_nombre").eq("es_trazable", true).eq("activo", true),
    supabase.from("tipos_producto").select("id, nombre").eq("activo", true).order("nombre"),
  ]);
  if (componentes.error) throw componentes.error;
  if (tipos.error) throw tipos.error;
  return {
    modelos: [...new Set((componentes.data || []).map((c) => norm(c.modelo)).filter(Boolean))].sort(),
    estados: [...new Set((componentes.data || []).map((c) => norm(c.estado_nombre)).filter(Boolean))].sort(),
    tipos: tipos.data || [],
  };
}

// `opciones`: { modelos: string[], estados: string[], tipos: {id,nombre}[] }
export function buildFiltrosComponentes(opciones, onChange) {
  const modelo = buildSearchSelect({
    id: "f-comp-modelo",
    placeholder: "Buscar modelo…",
    value: filtrosComponentes.modelo,
    options: [
      { value: "", label: "Todos los modelos" },
      ...opciones.modelos.map((m) => ({ value: m, label: m })),
    ],
    onChange: (v) => { filtrosComponentes.modelo = v; onChange(); },
  });

  const estado = buildSearchSelect({
    id: "f-comp-estado",
    placeholder: "Buscar estado…",
    value: filtrosComponentes.estado,
    options: [
      { value: "", label: "Todos los estados" },
      ...opciones.estados.map((e) => ({ value: e, label: e })),
    ],
    onChange: (v) => { filtrosComponentes.estado = v; onChange(); },
  });

  const tipo = buildSearchSelect({
    id: "f-comp-tipo",
    placeholder: "Buscar tipo de producto…",
    value: filtrosComponentes.tipo,
    options: [
      { value: "", label: "Todos los tipos" },
      ...opciones.tipos.map((t) => ({ value: String(t.id), label: t.nombre })),
      { value: "__none__", label: "Sin tipo" },
    ],
    onChange: (v) => { filtrosComponentes.tipo = v; onChange(); },
  });

  return el("div", { class: "filters" }, [
    el("div", { class: "filter filter--primary" }, [el("label", { class: "filter-label", for: "f-comp-modelo", text: "Modelo" }), modelo]),
    el("div", { class: "filter filter--primary" }, [el("label", { class: "filter-label", for: "f-comp-estado", text: "Estado" }), estado]),
    el("div", { class: "filter filter--primary" }, [el("label", { class: "filter-label", for: "f-comp-tipo", text: "Tipo de producto" }), tipo]),
  ]);
}

// Server-side, para Tarjetas/Tabla: `query` es un query builder de Supabase
// sobre vw_productos_trazables ya con `.eq("es_trazable", true)` puesto por
// crud.js (config.segments.key).
export function aplicarFiltrosComponentesQuery(query) {
  if (filtrosComponentes.modelo) query = query.eq("modelo", filtrosComponentes.modelo);
  if (filtrosComponentes.estado) query = query.eq("estado_nombre", filtrosComponentes.estado);
  if (filtrosComponentes.tipo) {
    query = filtrosComponentes.tipo === "__none__"
      ? query.is("tipo_producto_id", null)
      : query.eq("tipo_producto_id", filtrosComponentes.tipo);
  }
  return query;
}

// Cliente, para el Dashboard (que ya tiene todas las filas cargadas).
export function filasSegunFiltrosComponentes(filas) {
  return filas.filter((c) => {
    if (filtrosComponentes.modelo && norm(c.modelo) !== filtrosComponentes.modelo) return false;
    if (filtrosComponentes.estado && norm(c.estado_nombre) !== filtrosComponentes.estado) return false;
    if (filtrosComponentes.tipo) {
      if (filtrosComponentes.tipo === "__none__") { if (c.tipo_producto_id != null) return false; }
      else if (String(c.tipo_producto_id) !== filtrosComponentes.tipo) return false;
    }
    return true;
  });
}
