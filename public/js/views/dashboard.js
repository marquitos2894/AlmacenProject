// Panel — resumen del almacén. Solo consulta.
//
// Formas elegidas según el trabajo de cada dato (guía de data-viz):
//   · cifras de cabecera  -> KPIs (no gráficos de una barra)
//   · magnitud comparada  -> barras horizontales, un solo color (índigo)
//   · dos series por mes  -> columnas agrupadas (índigo entrada / naranja salida)
//   · actividad reciente  -> tabla
// Paleta validada: #5257dd + #eb6834 pasan todos los chequeos CVD en claro.
import { supabase } from "../supabaseClient.js";
import { el, clear, buildTable } from "../ui.js";

const S1 = "#5257dd";        // índigo — serie 1 / barras de una sola serie
const S2 = "#eb6834";        // naranja — serie 2 (salidas)
const INK = "#1f2333";
const INK2 = "#737890";
const MUTED = "#868ba0";
const GRID = "#e8e9f2";
const BASE = "#d4d6e2";

const nf = new Intl.NumberFormat("es-PE");
const fmt = (n) => nf.format(Math.round(Number(n) || 0));
const norm = (s) => String(s || "").trim();
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

export default {
  async render(root) {
    clear(root);
    root.appendChild(
      el("div", { class: "page-header" }, [
        el("div", {}, [
          el("h2", { class: "page-title", text: "Panel" }),
          el("p", { class: "page-subtitle", text: "Resumen del inventario, los movimientos y las existencias." }),
        ]),
      ])
    );

    const cargando = el("p", { class: "loading", text: "Cargando indicadores…" });
    root.appendChild(cargando);

    try {
      const data = await cargarDatos();
      cargando.remove();
      root.appendChild(vistaKpis(data));
      root.appendChild(seccion("Inventario y movimientos"));
      root.appendChild(vistaGraficos(data));
      root.appendChild(seccion("Equipos y componentes"));
      root.appendChild(vistaEquipos(data));
      root.appendChild(vistaActividad(data));
    } catch (err) {
      cargando.remove();
      root.appendChild(el("div", { class: "alert alert--error", text: `No se pudo cargar el panel: ${err.message}` }));
      console.error(err);
    }
  },
};

// ------------------------------------------------------------- Datos
async function cargarDatos() {
  const hoy = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const hace = (dias) => { const d = new Date(hoy); d.setDate(d.getDate() - dias); return iso(d); };
  const d30 = hace(30), d60 = hace(60), d180 = hace(182);

  const [
    productos, existencias, movsRecientes, movsPeriodo, detalle,
    almacenesCount, proveedoresCount, movs30, movsPrev30,
    equipos, asignaciones, compUnidades,
  ] = await Promise.all([
    supabase.from("productos").select("es_trazable").eq("activo", true),
    supabase.from("vw_producto_almacen").select("stock_actual, almacen_nombre, estado_nombre"),
    supabase.from("vw_movimientos").select("folio, fecha, tipo_movimiento, es_stock_inicial, almacen_nombre, total_cantidad, created_at").order("created_at", { ascending: false }).limit(8),
    supabase.from("movimientos").select("fecha, tipo_movimiento").gte("fecha", d180),
    supabase.from("vw_movimiento_detalle").select("producto_nombre, cantidad").limit(2000),
    supabase.from("almacenes").select("*", { count: "exact", head: true }).eq("activo", true),
    supabase.from("proveedores").select("*", { count: "exact", head: true }).eq("activo", true),
    supabase.from("movimientos").select("*", { count: "exact", head: true }).gte("fecha", d30),
    supabase.from("movimientos").select("*", { count: "exact", head: true }).gte("fecha", d60).lt("fecha", d30),
    supabase.from("vw_equipos_lista").select("estado_actual"),
    supabase.from("vw_equipo_unidad_operativa").select("equipo_id, unidad_nombre").eq("vigente", true),
    supabase.from("vw_producto_unidad_lista").select("estado_nombre, producto_nombre"),
  ]);

  const err = productos.error || existencias.error || movsRecientes.error || movsPeriodo.error
    || detalle.error || equipos.error || asignaciones.error || compUnidades.error;
  if (err) throw err;

  const prods = productos.data || [];
  const exs = existencias.data || [];
  const eqs = equipos.data || [];
  const asigs = asignaciones.data || [];
  const cus = compUnidades.data || [];

  // Existencias por almacén y por estado
  const porAlmacen = agrupaSuma(exs, (r) => r.almacen_nombre || "—", (r) => r.stock_actual);
  const porEstado = agrupaSuma(exs, (r) => r.estado_nombre || "Sin estado", (r) => r.stock_actual);

  // Productos más movidos (suma de cantidad en el detalle)
  const masMovidos = agrupaSuma(detalle.data || [], (r) => r.producto_nombre || "—", (r) => r.cantidad)
    .sort((a, b) => b.value - a.value).slice(0, 6);

  // Equipos: por estado y por unidad operativa (asignaciones vigentes).
  // Un equipo no puede tener dos asignaciones abiertas, así que contar filas
  // vigentes equivale a contar equipos asignados.
  const equiposPorEstado = agrupaSuma(eqs, (r) => norm(r.estado_actual) || "Sin estado", () => 1)
    .sort((a, b) => b.value - a.value);
  const equiposPorUnidad = agrupaSuma(asigs, (r) => r.unidad_nombre || "—", () => 1)
    .sort((a, b) => b.value - a.value);
  const equiposAsignados = new Set(asigs.map((r) => r.equipo_id)).size;
  const equiposDisponibles = Math.max(0, eqs.length - equiposAsignados);

  // Componentes: unidades individuales trazables, por estado.
  const compPorEstado = agrupaSuma(cus, (r) => norm(r.estado_nombre) || "Sin estado", () => 1)
    .sort((a, b) => b.value - a.value);

  // Movimientos por mes (últimos 6), entrada vs salida
  const meses = ultimosMeses(6);
  const porMes = meses.map((m) => ({ mes: m, entrada: 0, salida: 0 }));
  for (const mv of movsPeriodo.data || []) {
    const clave = String(mv.fecha).slice(0, 7);
    const fila = porMes.find((x) => x.mes === clave);
    if (!fila) continue;
    if (mv.tipo_movimiento === "salida") fila.salida += 1;
    else fila.entrada += 1;
  }

  return {
    totalStock: exs.reduce((s, r) => s + (Number(r.stock_actual) || 0), 0),
    totalProductos: prods.length,
    consumibles: prods.filter((p) => !p.es_trazable).length,
    componentes: prods.filter((p) => p.es_trazable).length,
    almacenes: almacenesCount.count ?? 0,
    proveedores: proveedoresCount.count ?? 0,
    movs30: movs30.count ?? 0,
    movsDelta: (movs30.count ?? 0) - (movsPrev30.count ?? 0),
    porAlmacen: porAlmacen.sort((a, b) => b.value - a.value),
    porEstado: porEstado.sort((a, b) => b.value - a.value),
    masMovidos,
    porMes,
    recientes: movsRecientes.data || [],
    equiposTotal: eqs.length,
    equiposAsignados,
    equiposDisponibles,
    equiposPorEstado,
    equiposPorUnidad,
    compUnidades: cus.length,
    compPorEstado,
  };
}

function agrupaSuma(rows, claveFn, valorFn) {
  const m = new Map();
  for (const r of rows) {
    const k = claveFn(r);
    m.set(k, (m.get(k) || 0) + (Number(valorFn(r)) || 0));
  }
  return [...m.entries()].map(([label, value]) => ({ label, value }));
}

function ultimosMeses(n) {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

// ------------------------------------------------------------- KPIs
function vistaKpis(d) {
  return el("div", { class: "kpi-row" }, [
    stat("Unidades en stock", fmt(d.totalStock), `${d.porAlmacen.length} almacén(es) con existencias`),
    stat("Productos activos", fmt(d.totalProductos), `${fmt(d.consumibles)} consumibles · ${fmt(d.componentes)} componentes`),
    stat("Movimientos (30 días)", fmt(d.movs30), deltaTexto(d.movsDelta)),
    stat("Equipos", fmt(d.equiposTotal), `${fmt(d.equiposAsignados)} asignados · ${fmt(d.equiposDisponibles)} disponibles`),
    stat("Componentes en seguimiento", fmt(d.compUnidades), `${fmt(d.componentes)} producto(s) trazables`),
    stat("Almacenes", fmt(d.almacenes)),
    stat("Proveedores", fmt(d.proveedores)),
  ]);
}

function stat(label, value, sub) {
  return el("div", { class: "kpi" }, [
    el("span", { class: "kpi__label", text: label }),
    el("span", { class: "kpi__value", text: value }),
    sub ? el("span", { class: "kpi__sub", text: sub }) : null,
  ]);
}

function deltaTexto(n) {
  if (!n) return "sin cambio vs. 30 días previos";
  const flecha = n > 0 ? "▲" : "▼";
  return `${flecha} ${fmt(Math.abs(n))} vs. 30 días previos`;
}

// ------------------------------------------------------------- Gráficos
function vistaGraficos(d) {
  return el("div", { class: "dash-grid" }, [
    tarjetaGrafico(
      "Movimientos por mes", "Últimos 6 meses · entradas y salidas",
      () => columnasAgrupadas(d.porMes),
      () => tablaMeses(d.porMes)
    ),
    tarjetaGrafico(
      "Existencias por almacén", "Unidades en stock",
      () => barrasH(d.porAlmacen, S1),
      () => tablaSimple(d.porAlmacen, "Almacén", "Unidades")
    ),
    tarjetaGrafico(
      "Existencias por estado", "Unidades en stock",
      () => barrasH(d.porEstado, S1),
      () => tablaSimple(d.porEstado, "Estado", "Unidades")
    ),
    tarjetaGrafico(
      "Productos más movidos", "Suma de cantidades movidas",
      () => barrasH(d.masMovidos, S1),
      () => tablaSimple(d.masMovidos, "Producto", "Cantidad")
    ),
  ]);
}

// ------------------------------------------------------- Equipos y componentes
function vistaEquipos(d) {
  return el("div", { class: "dash-grid" }, [
    tarjetaGrafico(
      "Asignación de equipos", "Equipos con asignación vigente frente a disponibles",
      () => barraApilada([
        { label: "Asignados", value: d.equiposAsignados, color: S1 },
        { label: "Disponibles", value: d.equiposDisponibles, color: "#c9cde0" },
      ]),
      () => tablaSimple(
        [{ label: "Asignados", value: d.equiposAsignados }, { label: "Disponibles", value: d.equiposDisponibles }],
        "Equipos", "Cantidad"
      )
    ),
    tarjetaGrafico(
      "Equipos por estado", "Estado actual del equipo",
      () => barrasH(d.equiposPorEstado, S1),
      () => tablaSimple(d.equiposPorEstado, "Estado", "Equipos")
    ),
    tarjetaGrafico(
      "Equipos por unidad operativa", "Asignaciones vigentes",
      () => barrasH(d.equiposPorUnidad, S1),
      () => tablaSimple(d.equiposPorUnidad, "Unidad operativa", "Equipos")
    ),
    tarjetaGrafico(
      "Componentes por estado", "Unidades trazables individuales",
      () => barrasH(d.compPorEstado, S1),
      () => tablaSimple(d.compPorEstado, "Estado", "Unidades")
    ),
  ]);
}

function seccion(texto) {
  return el("h3", { class: "dash-section-title", text: texto });
}

// Tarjeta con conmutador gráfico <-> tabla (todo gráfico tiene su gemela en tabla).
function tarjetaGrafico(titulo, subtitulo, hazGrafico, hazTabla) {
  const cuerpo = el("div", { class: "dash-card__body" }, [hazGrafico()]);
  let mostrandoTabla = false;
  const toggle = el("button", {
    class: "dash-card__toggle", type: "button", text: "Ver tabla",
    onclick: () => {
      mostrandoTabla = !mostrandoTabla;
      clear(cuerpo);
      cuerpo.appendChild(mostrandoTabla ? hazTabla() : hazGrafico());
      toggle.textContent = mostrandoTabla ? "Ver gráfico" : "Ver tabla";
    },
  });
  return el("section", { class: "dash-card" }, [
    el("div", { class: "dash-card__head" }, [
      el("div", {}, [
        el("h3", { class: "dash-card__title", text: titulo }),
        el("p", { class: "dash-card__sub", text: subtitulo }),
      ]),
      toggle,
    ]),
    cuerpo,
  ]);
}

// --- Barras horizontales, una sola serie (un color para todas las barras)
function barrasH(rows, color) {
  if (!rows.length) return el("p", { class: "dash-empty", text: "Sin datos todavía." });
  const W = 640, rh = 34, padT = 6, padB = 6;
  const H = padT + padB + rows.length * rh;
  const labelW = 150, valW = 54;
  const x0 = labelW, x1 = W - valW;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const svg = svgEl(W, H);

  rows.forEach((r, i) => {
    const cy = padT + i * rh + rh / 2;
    const bw = Math.max(2, ((x1 - x0) * r.value) / max);
    const bh = 18;
    svg.appendChild(node("text", {
      x: labelW - 12, y: cy, "text-anchor": "end", "dominant-baseline": "central",
      "font-size": "12", fill: INK2,
    }, recorta(r.label, 22)));
    const bar = node("path", { d: barraDer(x0, cy - bh / 2, bw, bh, 4), fill: color });
    bar.appendChild(node("title", {}, `${r.label}: ${fmt(r.value)}`));
    svg.appendChild(bar);
    svg.appendChild(node("text", {
      x: x0 + bw + 8, y: cy, "dominant-baseline": "central",
      "font-size": "12", "font-weight": "600", fill: INK, "font-variant-numeric": "tabular-nums",
    }, fmt(r.value)));
  });
  // línea base
  svg.appendChild(node("line", { x1: x0, y1: padT, x2: x0, y2: H - padB, stroke: BASE, "stroke-width": "1" }));
  return wrapSvg(svg);
}

// --- Barra apilada única (parte-del-todo, <=6 segmentos). Un color destaca,
// el resto en gris: es la forma "énfasis", no un pastel.
function barraApilada(segmentos) {
  const total = segmentos.reduce((s, x) => s + (Number(x.value) || 0), 0);
  if (!total) return el("p", { class: "dash-empty", text: "Sin datos todavía." });
  const W = 640, H = 60, x0 = 4, x1 = W - 4, y = 16, h = 26;
  const svg = svgEl(W, H);
  let x = x0;
  segmentos.forEach((seg, i) => {
    const w = Math.max(0, ((x1 - x0) * (Number(seg.value) || 0)) / total);
    if (w <= 0) return;
    const gap = i < segmentos.length - 1 ? 2 : 0; // 2px de superficie entre segmentos
    const rect = node("rect", { x, y, width: Math.max(1, w - gap), height: h, rx: 3, fill: seg.color });
    rect.appendChild(node("title", {}, `${seg.label}: ${fmt(seg.value)} (${Math.round((seg.value / total) * 100)}%)`));
    svg.appendChild(rect);
    if (w - gap > 30) {
      svg.appendChild(node("text", {
        x: x + (w - gap) / 2, y: y + h / 2, "text-anchor": "middle", "dominant-baseline": "central",
        "font-size": "12", "font-weight": "700", fill: esClaro(seg.color) ? INK : "#ffffff",
      }, fmt(seg.value)));
    }
    x += w;
  });
  return el("div", {}, [
    leyenda(segmentos.map((s) => [s.label, s.color])),
    wrapSvg(svg),
  ]);
}

// ¿El color de relleno es claro? (para elegir tinta o blanco en la etiqueta)
function esClaro(hex) {
  const m = String(hex).replace("#", "");
  const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150;
}

// --- Columnas agrupadas: entrada (índigo) vs salida (naranja), por mes
function columnasAgrupadas(porMes) {
  const W = 660, H = 300;
  const padL = 34, padR = 10, padT = 12, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(1, ...porMes.flatMap((m) => [m.entrada, m.salida]));
  const ticks = ticksLimpios(max, 4);
  const yMax = ticks[ticks.length - 1];
  const y = (v) => padT + plotH - (plotH * v) / yMax;

  const svg = svgEl(W, H);
  // rejilla + ticks
  for (const t of ticks) {
    svg.appendChild(node("line", { x1: padL, y1: y(t), x2: W - padR, y2: y(t), stroke: GRID, "stroke-width": "1" }));
    svg.appendChild(node("text", { x: padL - 8, y: y(t), "text-anchor": "end", "dominant-baseline": "central", "font-size": "11", fill: MUTED, "font-variant-numeric": "tabular-nums" }, fmt(t)));
  }
  svg.appendChild(node("line", { x1: padL, y1: y(0), x2: W - padR, y2: y(0), stroke: BASE, "stroke-width": "1" }));

  const bandW = plotW / porMes.length;
  const colW = Math.min(20, (bandW - 12) / 2 - 1); // 2px de aire entre el par
  porMes.forEach((m, i) => {
    const cx = padL + i * bandW + bandW / 2;
    const pares = [
      { v: m.entrada, color: S1, x: cx - colW - 1, etq: "entradas" },
      { v: m.salida, color: S2, x: cx + 1, etq: "salidas" },
    ];
    for (const p of pares) {
      const h = Math.max(0, y(0) - y(p.v));
      if (h > 0) {
        const bar = node("path", { d: barraSup(p.x, y(p.v), colW, h, 4), fill: p.color });
        bar.appendChild(node("title", {}, `${nombreMes(m.mes)}: ${fmt(p.v)} ${p.etq}`));
        svg.appendChild(bar);
        if (h > 16) {
          svg.appendChild(node("text", { x: p.x + colW / 2, y: y(p.v) - 5, "text-anchor": "middle", "font-size": "10.5", "font-weight": "600", fill: INK2 }, fmt(p.v)));
        }
      }
    }
    svg.appendChild(node("text", { x: cx, y: H - 10, "text-anchor": "middle", "font-size": "11", fill: MUTED }, nombreMes(m.mes)));
  });

  return el("div", {}, [leyenda([["Entradas", S1], ["Salidas", S2]]), wrapSvg(svg)]);
}

function leyenda(items) {
  return el("div", { class: "dash-legend" },
    items.map(([txt, color]) =>
      el("span", { class: "dash-legend__item" }, [
        el("span", { class: "dash-legend__swatch", style: `background:${color}` }),
        el("span", { text: txt }),
      ])
    )
  );
}

// ------------------------------------------------------- Actividad reciente
function vistaActividad(d) {
  const cols = [
    { key: "folio", label: "Folio", render: (r) => el("span", { class: "folio-tag mono", text: r.folio || "—" }) },
    { key: "fecha", label: "Fecha", render: (r) => textoFecha(r.fecha) },
    { key: "tipo", label: "Tipo", render: (r) => badgeTipo(r) },
    { key: "almacen_nombre", label: "Almacén" },
    { key: "total_cantidad", label: "Cantidad", render: (r) => el("span", { class: "mono", text: r.total_cantidad == null ? "—" : fmt(r.total_cantidad) }) },
  ];
  return el("section", { class: "dash-card" }, [
    el("div", { class: "dash-card__head" }, [
      el("div", {}, [
        el("h3", { class: "dash-card__title", text: "Actividad reciente" }),
        el("p", { class: "dash-card__sub", text: "Últimos movimientos registrados" }),
      ]),
      el("a", { class: "dash-card__toggle", href: "#/movimientos", text: "Ver todos" }),
    ]),
    el("div", { class: "dash-card__body" }, [
      d.recientes.length ? buildTable(cols, d.recientes, null) : el("p", { class: "dash-empty", text: "Todavía no hay movimientos." }),
    ]),
  ]);
}

function badgeTipo(r) {
  if (r.es_stock_inicial) return el("span", { class: "badge badge--inicial", text: "Stock inicial" });
  const salida = r.tipo_movimiento === "salida";
  return el("span", { class: `badge ${salida ? "badge--out" : "badge--in"}`, text: salida ? "Salida" : "Entrada" });
}

// ------------------------------------------------------------- Tablas gemelas
function tablaSimple(rows, c1, c2) {
  return buildTable(
    [{ key: "label", label: c1 }, { key: "value", label: c2, render: (r) => el("span", { class: "mono", text: fmt(r.value) }) }],
    rows, null
  );
}
function tablaMeses(porMes) {
  return buildTable(
    [
      { key: "mes", label: "Mes", render: (r) => nombreMes(r.mes) },
      { key: "entrada", label: "Entradas", render: (r) => el("span", { class: "mono", text: fmt(r.entrada) }) },
      { key: "salida", label: "Salidas", render: (r) => el("span", { class: "mono", text: fmt(r.salida) }) },
    ],
    porMes, null
  );
}

// ------------------------------------------------------------- Utilidades SVG
function svgEl(w, h) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", `0 0 ${w} ${h}`);
  s.setAttribute("width", "100%");
  s.setAttribute("preserveAspectRatio", "xMinYMin meet");
  s.setAttribute("role", "img");
  s.style.display = "block";
  return s;
}
function node(tag, attrs, text) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}
function wrapSvg(svg) {
  return el("div", { class: "dash-chart" }, [svg]);
}
// Barra con extremo derecho redondeado, base cuadrada a la izquierda.
function barraDer(x, y, w, h, r) {
  r = Math.min(r, w, h / 2);
  return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`;
}
// Columna con tope redondeado, base cuadrada abajo.
function barraSup(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}
function ticksLimpios(max, n) {
  const paso = Math.max(1, Math.ceil(max / n));
  const p = Math.pow(10, Math.floor(Math.log10(paso)));
  const bonito = [1, 2, 2.5, 5, 10].map((k) => k * p).find((k) => k >= paso) || paso;
  const out = [];
  for (let v = 0; v <= max + bonito - 0.001; v += bonito) out.push(Math.round(v));
  return out.length > 1 ? out : [0, 1];
}
function recorta(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function nombreMes(clave) {
  const [y, m] = String(clave).split("-").map(Number);
  return `${MESES[(m - 1) % 12]} ${String(y).slice(2)}`;
}
function textoFecha(f) {
  if (!f) return "—";
  const [y, m, d] = String(f).slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat("es-PE", { dateStyle: "medium" }).format(new Date(y, m - 1, d));
}
