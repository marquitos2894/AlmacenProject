// Filtro de Componentes (modelo, estado, tipo de producto, establecimiento y
// etiqueta): estado y lógica compartidos entre las tres vistas de Productos →
// Componentes (Tarjetas, Tabla y Dashboard), para que elegir un filtro en una
// se mantenga al pasar a otra en vez de tener tres copias independientes.
// La etiqueta también la usa la pestaña Consumibles (misma agrupación por #).
import { supabase } from "../supabaseClient.js";
import { el, buildSearchSelect } from "../ui.js";

const norm = (s) => String(s || "").trim();

export const filtrosComponentes = { modelo: "", estado: "", tipo: "", unidad: "", etiqueta: "" };

export const hayFiltroComponentesActivo = () =>
  !!(filtrosComponentes.modelo || filtrosComponentes.estado || filtrosComponentes.tipo
    || filtrosComponentes.unidad || filtrosComponentes.etiqueta);

// Establecimientos (catálogo) y etiquetas en uso: salen del catálogo/vista y no
// de las filas de la página, para que los combos sean iguales en las tres vistas.
export async function cargarUnidades() {
  const { data, error } = await supabase.from("unidad_operativa").select("id, nombre").eq("activo", true).order("nombre");
  if (error) throw error;
  return data || [];
}

export async function cargarEtiquetas() {
  const { data, error } = await supabase.from("vw_etiquetas_producto").select("etiqueta").order("etiqueta");
  if (error) throw error;
  return (data || []).map((r) => r.etiqueta);
}

// Listas para los combos (modelos/estados en uso + catálogos). Es una
// consulta liviana sobre todos los componentes activos —Tarjetas/Tabla solo
// traen la página actual, así que los combos no pueden salir de esos datos—.
// El dashboard, que ya trae todas las filas para las gráficas, arma sus
// propias opciones de modelo/estado a partir de ellas sin repetir esta consulta.
export async function cargarOpcionesFiltroComponentes() {
  const [componentes, tipos, unidades, etiquetas] = await Promise.all([
    supabase.from("vw_productos_trazables").select("modelo, estado_nombre").eq("es_trazable", true).eq("activo", true),
    supabase.from("tipos_producto").select("id, nombre").eq("activo", true).order("nombre"),
    cargarUnidades(),
    cargarEtiquetas(),
  ]);
  if (componentes.error) throw componentes.error;
  if (tipos.error) throw tipos.error;
  return {
    modelos: [...new Set((componentes.data || []).map((c) => norm(c.modelo)).filter(Boolean))].sort(),
    estados: [...new Set((componentes.data || []).map((c) => norm(c.estado_nombre)).filter(Boolean))].sort(),
    tipos: tipos.data || [],
    unidades,
    etiquetas,
  };
}

function comboEtiqueta(etiquetas, onChange) {
  return buildSearchSelect({
    id: "f-prod-etiqueta",
    placeholder: "Buscar etiqueta…",
    emptyText: "Todavía no hay etiquetas.",
    value: filtrosComponentes.etiqueta,
    options: [
      { value: "", label: "Todas las etiquetas" },
      ...etiquetas.map((t) => ({ value: t, label: `#${t}` })),
    ],
    onChange: (v) => { filtrosComponentes.etiqueta = v; onChange(); },
  });
}

// Solo el combo de etiqueta, para la pestaña Consumibles.
export function buildFiltroEtiqueta(etiquetas, onChange) {
  return el("div", { class: "filters" }, [
    el("div", { class: "filter filter--primary" }, [
      el("label", { class: "filter-label", for: "f-prod-etiqueta", text: "Etiqueta" }),
      comboEtiqueta(etiquetas, onChange),
    ]),
  ]);
}

export function aplicarFiltroEtiquetaQuery(query) {
  return filtrosComponentes.etiqueta ? query.contains("etiquetas", [filtrosComponentes.etiqueta]) : query;
}

// `opciones`: { modelos: string[], estados: string[], tipos: {id,nombre}[],
//               unidades: {id,nombre}[], etiquetas: string[] }
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

  const unidad = buildSearchSelect({
    id: "f-comp-unidad",
    placeholder: "Buscar establecimiento…",
    value: filtrosComponentes.unidad,
    options: [
      { value: "", label: "Todos los establecimientos" },
      ...opciones.unidades.map((u) => ({ value: String(u.id), label: u.nombre })),
      { value: "__none__", label: "Sin establecimiento" },
    ],
    onChange: (v) => { filtrosComponentes.unidad = v; onChange(); },
  });

  return el("div", { class: "filters" }, [
    el("div", { class: "filter filter--primary" }, [el("label", { class: "filter-label", for: "f-comp-unidad", text: "Pertenece a" }), unidad]),
    el("div", { class: "filter filter--primary" }, [el("label", { class: "filter-label", for: "f-prod-etiqueta", text: "Etiqueta" }), comboEtiqueta(opciones.etiquetas, onChange)]),
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
  if (filtrosComponentes.unidad) {
    query = filtrosComponentes.unidad === "__none__"
      ? query.is("unidad_operativa_id", null)
      : query.eq("unidad_operativa_id", filtrosComponentes.unidad);
  }
  return aplicarFiltroEtiquetaQuery(query);
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
    if (filtrosComponentes.unidad) {
      if (filtrosComponentes.unidad === "__none__") { if (c.unidad_operativa_id != null) return false; }
      else if (String(c.unidad_operativa_id) !== filtrosComponentes.unidad) return false;
    }
    if (filtrosComponentes.etiqueta && !(c.etiquetas || []).includes(filtrosComponentes.etiqueta)) return false;
    return true;
  });
}
