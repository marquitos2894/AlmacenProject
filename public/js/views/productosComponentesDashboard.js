// Dashboard de Componentes (productos trazables): resumen + filtros propios.
// Se engancha como `dashboard(container, rerender)` en la opción "Componentes"
// de los `segments` de productos.js (ver crud.js: createCrudView agrega el
// modo "Dashboard" a la pestaña que lo declare).
//
// Formas elegidas (mismo criterio que el Panel y el dashboard de Equipos):
//   · Cifras de cabecera            -> KPIs.
//   · Magnitud por categoría        -> barras horizontales (etiquetas largas
//     o cortas por igual: modelo, tipo, estado). Un solo color: no hay
//     series que distinguir.
//   · Parte del todo (en stock/no)  -> barra apilada de 2 segmentos.
// No se usa un pastel/dona: para comparar magnitudes entre pocas categorías
// una barra se lee mejor y evita el problema clásico de comparar ángulos.
//
// El filtro (modelo/estado/tipo) es compartido con Tarjetas y Tabla —ver
// productosComponentesFiltros.js— para que elegirlo en una vista se
// mantenga al pasar a otra.
import { supabase } from "../supabaseClient.js";
import { el, clear } from "../ui.js";
import { barrasH, barraApilada, tarjetaGrafico, tablaSimple } from "../charts.js";
import { badgeEstado } from "../badges.js";
import {
  hayFiltroComponentesActivo, buildFiltrosComponentes, filasSegunFiltrosComponentes,
} from "./productosComponentesFiltros.js";

const S1 = "#5257dd"; // índigo — mismo color que el resto de los dashboards de la app
const norm = (s) => String(s || "").trim();
const MAX_FILAS_COMPACTAS = 30;

export async function renderDashboardComponentes(container) {
  clear(container);
  let data;
  try {
    data = await cargarDatos();
  } catch (err) {
    container.appendChild(el("div", { class: "alert alert--error", text: `No se pudo cargar el dashboard: ${err.message}` }));
    return;
  }

  const cuerpo = el("div", {});
  const pintar = () => { clear(cuerpo); cuerpo.appendChild(construirCuerpo(data)); };
  // El dashboard ya tiene todas las filas cargadas: las opciones del filtro
  // salen de ahí mismo, sin otra consulta (a diferencia de Tarjetas/Tabla).
  const opciones = {
    modelos: [...new Set(data.componentes.map((c) => norm(c.modelo)).filter(Boolean))].sort(),
    estados: [...new Set(data.componentes.map((c) => norm(c.estado_nombre)).filter(Boolean))].sort(),
    tipos: data.tipos,
  };
  container.appendChild(buildFiltrosComponentes(opciones, pintar));
  container.appendChild(cuerpo);
  pintar();
}

async function cargarDatos() {
  const [componentes, tipos] = await Promise.all([
    supabase
      .from("vw_productos_trazables")
      .select("id, nombre, no_serie, codigo_interno, modelo, estado_nombre, tipo_producto_id, tipo_producto_nombre, producto_almacen_id")
      .eq("es_trazable", true)
      .eq("activo", true),
    supabase.from("tipos_producto").select("id, nombre").eq("activo", true).order("nombre"),
  ]);

  const err = componentes.error || tipos.error;
  if (err) throw err;

  return {
    componentes: componentes.data || [],
    tipos: tipos.data || [],
  };
}

function construirCuerpo(d) {
  const filas = filasSegunFiltrosComponentes(d.componentes);
  if (!filas.length) {
    return el("div", { class: "empty-state" }, [el("p", { text: "Ningún componente coincide con el filtro." })]);
  }

  const porModelo = agrupaPor(filas, (c) => norm(c.modelo) || "Sin modelo");
  const porTipo = agrupaPor(filas, (c) => c.tipo_producto_nombre || "Sin tipo");
  const porEstado = agrupaPor(filas, (c) => norm(c.estado_nombre) || "Sin estado");
  const enStock = filas.filter((c) => c.producto_almacen_id != null).length;
  const sinStock = filas.length - enStock;

  return el("div", {}, [
    el("div", { class: "kpi-row" }, [
      kpi("Componentes", String(filas.length), `${enStock} en stock · ${sinStock} sin stock`),
      kpi("Modelos distintos", String(porModelo.length)),
      kpi("Tipos de producto", String(d.tipos.length), "en el catálogo"),
    ]),
    el("div", { class: "dash-grid" }, [
      // Con un filtro activo, la lista compacta de qué componentes exactos
      // caen en el recorte va primero — es lo que más se quiere ver justo
      // después de filtrar.
      ...(hayFiltroComponentesActivo() ? [tarjetaListaCompacta(filas)] : []),
      tarjetaGrafico(
        "En stock vs. sin stock", "Tiene o no una existencia activa registrada",
        () => barraApilada([
          { label: "En stock", value: enStock, color: S1 },
          { label: "Sin stock", value: sinStock, color: "#c9cde0" },
        ]),
        () => tablaSimple(
          [{ label: "En stock", value: enStock }, { label: "Sin stock", value: sinStock }],
          "Existencia", "Componentes"
        )
      ),
      tarjetaGrafico(
        "Componentes por modelo", "Cuántos componentes hay de cada modelo",
        () => barrasH(porModelo, S1),
        () => tablaSimple(porModelo, "Modelo", "Componentes")
      ),
      tarjetaGrafico(
        "Componentes por tipo de producto", "Clasificación del catálogo Tipos de producto",
        () => barrasH(porTipo, S1),
        () => tablaSimple(porTipo, "Tipo", "Componentes")
      ),
      tarjetaGrafico(
        "Componentes por estado", "Estado actual de la existencia",
        () => barrasH(porEstado, S1),
        () => tablaSimple(porEstado, "Estado", "Componentes")
      ),
    ]),
  ]);
}

// Tarjeta compacta con los componentes del filtro activo: solo nombre,
// serie/código y estado — el detalle completo ya está en Tarjetas/Tabla con
// el mismo filtro aplicado, así que aquí basta con identificar de un
// vistazo cuáles son.
function tarjetaListaCompacta(filas) {
  const ordenadas = [...filas].sort((a, b) => (a.nombre || "").localeCompare(b.nombre || ""));
  const excedente = ordenadas.length - MAX_FILAS_COMPACTAS;
  const visibles = excedente > 0 ? ordenadas.slice(0, MAX_FILAS_COMPACTAS) : ordenadas;

  const lista = el("div", { class: "dash-list" }, visibles.map((c) => el("div", { class: "dash-list__row" }, [
    el("div", { class: "cell-stack" }, [
      el("div", { text: c.nombre || "—" }),
      el("div", { class: "cell-sub mono", text: (c.no_serie || c.codigo_interno) || "—" }),
    ]),
    badgeEstado(c.estado_nombre),
  ])));

  return el("section", { class: "dash-card" }, [
    el("div", { class: "dash-card__head" }, [
      el("div", {}, [
        el("h3", { class: "dash-card__title", text: "Componentes del filtro" }),
        el("p", {
          class: "dash-card__sub",
          text: excedente > 0 ? `Mostrando ${MAX_FILAS_COMPACTAS} de ${ordenadas.length}` : `${ordenadas.length} componente(s)`,
        }),
      ]),
    ]),
    el("div", { class: "dash-card__body dash-card__body--scroll" }, [lista]),
  ]);
}

function kpi(label, value, sub) {
  return el("div", { class: "kpi" }, [
    el("span", { class: "kpi__label", text: label }),
    el("span", { class: "kpi__value", text: value }),
    sub ? el("span", { class: "kpi__sub", text: sub }) : null,
  ]);
}

function agrupaPor(filas, claveFn) {
  const m = new Map();
  for (const c of filas) {
    const clave = claveFn(c);
    m.set(clave, (m.get(clave) || 0) + 1);
  }
  return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}
