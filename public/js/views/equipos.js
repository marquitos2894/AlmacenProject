// Equipos — vista a medida: cuadrícula de tarjetas, filtro por unidad
// operativa, historial de asignaciones y conmutador a tabla.
//
// La "unidad actual" real de un equipo es su asignación VIGENTE en
// equipo_unidad_operativa (fila sin fecha_fin); las columnas denormalizadas
// `unidad_actual` / `estado_actual` de `equipos` no son de fiar.
import { supabase } from "../supabaseClient.js";
import { puedeEditar } from "../auth.js";
import { openForm, softDelete } from "../crud.js";
import { abrirHistorialEquipo, tagUnidad } from "../historialEquipo.js";
import { cfgAbrirAsignacion, cfgCerrarAsignacion, cfgEditarAsignacion } from "../asignacionForm.js";
import { badgeEstado } from "../badges.js";
import { el, clear, buildTable, iconButton, buildPaginador, buildSearchSelect } from "../ui.js";
import { icon } from "../icons.js";
import { barrasH, barraApilada, tarjetaGrafico, tablaSimple } from "../charts.js";

const S1 = "#5257dd"; // índigo — mismo color que usa el Panel para barras de una sola serie

// Config mínima para reutilizar el formulario/borrado estándar del CRUD.
const CRUD = {
  table: "equipos",
  title: "Equipos",
  singular: "equipo",
  fields: [
    // Identidad: solo al dar de alta. Al editar se ocultan (no se retocan).
    { name: "codigo", label: "Código", type: "text", hideOnEdit: true, hint: "No puede repetirse entre equipos activos." },
    { name: "nombre", label: "Nombre", type: "text", hideOnEdit: true },
    { name: "modelo", label: "Modelo", type: "text", required: true },
    { name: "marca", label: "Marca", type: "text" },
    {
      name: "tipo_equipo_id", label: "Tipo de equipo", type: "select",
      source: { table: "tipos_equipo", value: "id", label: "nombre" },
      hint: "Opcional; se administra en Catálogos → Tipos de equipo.",
    },
    {
      name: "anio_fabricacion", label: "Año de fabricación", type: "number",
      placeholder: "2020", hint: "Opcional.",
    },
    { name: "no_serie", label: "No. de serie", type: "text" },
    { name: "descripcion", label: "Descripción", type: "textarea" },
  ],
};

// Estado que sobrevive a los re-render.
const filtros = { unidad: "", estado: "", q: "" };
// Filtro propio del dashboard: independiente del de la lista, para poder
// acotar el resumen a un establecimiento y/o tipo sin perder el filtro de
// la lista de tarjetas/tabla (son pestañas distintas).
const dashFiltros = { unidad: "", tipo: "", modelo: "" };
let modo = "tarjetas"; // "tarjetas" | "tabla" | "dashboard"
let paginaEq = 0;
const PAGE = 50; // equipos por página (se pagina en cliente: el set es pequeño y viene ya unido)

const norm = (s) => String(s || "").trim();
const hoy = () => new Date().toISOString().slice(0, 10);

// Acciones de asignación de un equipo, según tenga o no una asignación vigente.
// No se puede abrir una nueva mientras haya vigente: hay que cerrarla antes.
function accionesAsignacion(e, vig, rerender) {
  const editable = puedeEditar();
  return {
    onAbrir: editable && !vig ? () => openForm(cfgAbrirAsignacion(e), null, rerender) : null,
    onCerrar: editable && vig
      ? () => openForm(cfgCerrarAsignacion(e), { ...vig, fecha_fin: hoy() }, rerender)
      : null,
    onEditar: editable ? (asg) => openForm(cfgEditarAsignacion(e), asg, rerender) : null,
  };
}

// Botones de asignación para el pie de tarjeta / celda de acciones.
function botonesAsignacion(vig, { onAbrir, onCerrar }) {
  const btnAbrir = iconButton("Asignar a establecimiento", "btn--ghost", onAbrir, "equipos-unidad");
  if (vig) {
    btnAbrir.disabled = true;
    btnAbrir.title = "Cierra la asignación vigente antes de reasignar";
  }
  return [
    btnAbrir,
    vig ? iconButton("Cerrar asignación vigente", "btn--ghost", onCerrar, "link-off") : null,
  ].filter(Boolean);
}

export default {
  async render(root) {
    const rerender = () => this.render(root);
    clear(root);

    root.appendChild(
      el("div", { class: "page-header" }, [
        el("div", {}, [
          el("h2", { class: "page-title", text: "Equipos" }),
          el("p", { class: "page-subtitle", text: "Maquinaria y su asignación vigente a establecimientos." }),
        ]),
        el("div", { class: "page-header__actions" }, [
          buildTabsVista(rerender),
          puedeEditar()
            ? el("button", { class: "btn btn--primary", text: "+ Nuevo equipo", onclick: () => openForm(CRUD, null, rerender) })
            : null,
        ]),
      ])
    );

    const cont = el("div", {}, [el("p", { class: "loading", text: "Cargando equipos…" })]);
    root.appendChild(cont);

    let data;
    try {
      data = await cargarDatos();
    } catch (err) {
      clear(cont);
      cont.appendChild(el("div", { class: "alert alert--error", text: `No se pudieron cargar los equipos: ${err.message}` }));
      return;
    }

    clear(cont);

    if (modo === "dashboard") {
      cont.appendChild(construirDashboard(data));
      return;
    }

    const lista = el("div", {});
    cont.appendChild(buildFiltros(data, () => { paginaEq = 0; pintar(); }));
    cont.appendChild(lista);
    pintar();

    function pintar() {
      clear(lista);
      const filas = filtrar(data);
      const totalPaginas = Math.max(1, Math.ceil(filas.length / PAGE));
      if (paginaEq > totalPaginas - 1) paginaEq = totalPaginas - 1;
      const enPagina = filas.slice(paginaEq * PAGE, paginaEq * PAGE + PAGE);

      lista.appendChild(
        modo === "tabla" ? construirTabla(enPagina, data, rerender) : construirGrid(enPagina, data, rerender)
      );

      const desde = filas.length ? paginaEq * PAGE + 1 : 0;
      const hasta = Math.min(filas.length, (paginaEq + 1) * PAGE);
      lista.appendChild(
        el("div", { class: "list-foot" }, [
          el("p", { class: "list-meta", text: filas.length ? `${desde}–${hasta} de ${filas.length} equipo(s)` : "0 equipos" }),
          buildPaginador(paginaEq, totalPaginas, (p) => { paginaEq = p; pintar(); }),
        ])
      );
    }
  },
};

// Tres vistas de la misma lista: tarjetas, tabla y un resumen (dashboard).
function buildTabsVista(rerender) {
  const tabs = [
    { id: "tarjetas", label: "Tarjetas", icon: "grid" },
    { id: "tabla", label: "Tabla", icon: "table" },
    { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  ];
  return el("div", { class: "view-tabs" }, tabs.map((t) =>
    el("button", {
      class: `view-tabs__btn${modo === t.id ? " view-tabs__btn--active" : ""}`,
      type: "button",
      html: `${icon(t.icon, { size: 14, stroke: 1.9 })}<span>${t.label}</span>`,
      onclick: () => { modo = t.id; rerender(); },
    })
  ));
}

// ------------------------------------------------------------- Dashboard
// Filtros propios + cuatro lecturas del mismo conjunto de equipos: cuánto hay
// y cuánto está disponible, y las tres formas más útiles de repartirlo
// (dónde están, qué tipo son, en qué estado están).
function construirDashboard(d) {
  const root = el("div", {});
  const cuerpo = el("div", {});
  const pintar = () => { clear(cuerpo); cuerpo.appendChild(cuerpoDashboard(d)); };
  root.appendChild(buildFiltrosDashboard(d, pintar));
  root.appendChild(cuerpo);
  pintar();
  return root;
}

function buildFiltrosDashboard(d, onChange) {
  const unidad = buildSearchSelect({
    id: "f-dash-unidad",
    placeholder: "Buscar establecimiento…",
    value: dashFiltros.unidad,
    options: [
      { value: "", label: "Todos los establecimientos" },
      ...d.unidades.map((u) => ({ value: String(u.id), label: u.nombre })),
      { value: "__none__", label: "Sin asignar" },
    ],
    onChange: (v) => { dashFiltros.unidad = v; onChange(); },
  });

  const tiposOrdenados = [...d.tipoNombrePorId.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const tipo = buildSearchSelect({
    id: "f-dash-tipo",
    placeholder: "Buscar tipo de equipo…",
    value: dashFiltros.tipo,
    options: [
      { value: "", label: "Todos los tipos" },
      ...tiposOrdenados.map(([id, nombre]) => ({ value: String(id), label: nombre })),
      { value: "__none__", label: "Sin tipo" },
    ],
    onChange: (v) => { dashFiltros.tipo = v; onChange(); },
  });

  const modelosOrdenados = [...new Set(d.equipos.map((e) => norm(e.modelo)).filter(Boolean))].sort();
  const modelo = buildSearchSelect({
    id: "f-dash-modelo",
    placeholder: "Buscar modelo…",
    value: dashFiltros.modelo,
    options: [
      { value: "", label: "Todos los modelos" },
      ...modelosOrdenados.map((m) => ({ value: m, label: m })),
    ],
    onChange: (v) => { dashFiltros.modelo = v; onChange(); },
  });

  return el("div", { class: "filters" }, [
    el("div", { class: "filter filter--primary" }, [el("label", { class: "filter-label", for: "f-dash-unidad", text: "Establecimiento" }), unidad]),
    el("div", { class: "filter filter--primary" }, [el("label", { class: "filter-label", for: "f-dash-tipo", text: "Tipo de equipo" }), tipo]),
    el("div", { class: "filter filter--primary" }, [el("label", { class: "filter-label", for: "f-dash-modelo", text: "Modelo" }), modelo]),
  ]);
}

function filasDashboard(d) {
  return d.equipos.filter((e) => {
    if (dashFiltros.tipo) {
      if (dashFiltros.tipo === "__none__") { if (e.tipo_equipo_id != null) return false; }
      else if (String(e.tipo_equipo_id) !== dashFiltros.tipo) return false;
    }
    if (dashFiltros.unidad) {
      const vig = d.vigentePorEquipo.get(e.id);
      if (dashFiltros.unidad === "__none__") { if (vig) return false; }
      else if (!vig || String(vig.unidad_operativa_id) !== dashFiltros.unidad) return false;
    }
    if (dashFiltros.modelo && norm(e.modelo) !== dashFiltros.modelo) return false;
    return true;
  });
}

function cuerpoDashboard(d) {
  const filas = filasDashboard(d);
  if (!filas.length) {
    return el("div", { class: "empty-state" }, [el("p", { text: "Ningún equipo coincide con el filtro." })]);
  }

  const porEstablecimiento = agrupaPorEstablecimiento(d, filas);
  const porTipo = agrupaPorTipo(d, filas);
  const porEstado = agrupaPorEstado(filas);
  const porModelo = agrupaPorModelo(filas);
  const asignados = filas.filter((e) => d.vigentePorEquipo.has(e.id)).length;
  const disponibles = filas.length - asignados;
  const establecimientosConEquipos = porEstablecimiento.filter((r) => r.label !== "Sin asignar").length;

  return el("div", {}, [
    el("div", { class: "kpi-row" }, [
      kpi("Equipos", String(filas.length), `${asignados} asignado(s) · ${disponibles} disponible(s)`),
      kpi("Tipos de equipo", String(d.tiposCount), "en el catálogo"),
      kpi("Modelos distintos", String(porModelo.length)),
      kpi("Establecimientos con equipos", String(establecimientosConEquipos)),
    ]),
    el("div", { class: "dash-grid" }, [
      tarjetaGrafico(
        "Asignación de equipos", "Con asignación vigente frente a disponibles",
        () => barraApilada([
          { label: "Asignados", value: asignados, color: S1 },
          { label: "Disponibles", value: disponibles, color: "#c9cde0" },
        ]),
        () => tablaSimple(
          [{ label: "Asignados", value: asignados }, { label: "Disponibles", value: disponibles }],
          "Equipos", "Cantidad"
        )
      ),
      tarjetaGrafico(
        "Equipos por establecimiento", "Según la asignación vigente de cada equipo",
        () => barrasH(porEstablecimiento, S1),
        () => tablaSimple(porEstablecimiento, "Establecimiento", "Equipos")
      ),
      tarjetaGrafico(
        "Equipos por modelo", "Cuántos equipos hay de cada modelo",
        () => barrasH(porModelo, S1),
        () => tablaSimple(porModelo, "Modelo", "Equipos")
      ),
      tarjetaGrafico(
        "Equipos por tipo", "Clasificación registrada en el equipo",
        () => barrasH(porTipo, S1),
        () => tablaSimple(porTipo, "Tipo", "Equipos")
      ),
      tarjetaGrafico(
        "Equipos por estado", "Estado actual del equipo",
        () => barrasH(porEstado, S1),
        () => tablaSimple(porEstado, "Estado", "Equipos")
      ),
    ]),
  ]);
}

function kpi(label, value, sub) {
  return el("div", { class: "kpi" }, [
    el("span", { class: "kpi__label", text: label }),
    el("span", { class: "kpi__value", text: value }),
    sub ? el("span", { class: "kpi__sub", text: sub }) : null,
  ]);
}

function agrupaPorEstablecimiento(d, filas) {
  const m = new Map();
  for (const e of filas) {
    const vig = d.vigentePorEquipo.get(e.id);
    const clave = vig ? (vig.unidad_nombre || "—") : "Sin asignar";
    m.set(clave, (m.get(clave) || 0) + 1);
  }
  return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

function agrupaPorTipo(d, filas) {
  const m = new Map();
  for (const e of filas) {
    const clave = d.tipoNombrePorId.get(e.tipo_equipo_id) || "Sin tipo";
    m.set(clave, (m.get(clave) || 0) + 1);
  }
  return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

function agrupaPorModelo(filas) {
  const m = new Map();
  for (const e of filas) {
    const clave = norm(e.modelo) || "Sin modelo";
    m.set(clave, (m.get(clave) || 0) + 1);
  }
  return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

function agrupaPorEstado(filas) {
  const m = new Map();
  for (const e of filas) {
    const clave = norm(e.estado_actual) || "Sin estado";
    m.set(clave, (m.get(clave) || 0) + 1);
  }
  return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

// ------------------------------------------------------------- Datos
async function cargarDatos() {
  const [equipos, asignaciones, unidades, tipos] = await Promise.all([
    supabase.from("equipos").select("*").eq("activo", true).order("modelo"),
    supabase
      .from("vw_equipo_unidad_operativa")
      .select("id, equipo_id, unidad_operativa_id, unidad_nombre, codigo_asignado, estado_id, estado_nombre, fecha_inicio, fecha_fin, horometro_inicial, horometro_final, observacion, vigente")
      .order("fecha_inicio", { ascending: false }),
    supabase.from("unidad_operativa").select("id, nombre").eq("activo", true).order("nombre"),
    supabase.from("tipos_equipo").select("id, nombre").eq("activo", true).order("nombre"),
  ]);

  const err = equipos.error || asignaciones.error || unidades.error || tipos.error;
  if (err) throw err;

  const vigentePorEquipo = new Map();
  const historialPorEquipo = new Map();
  for (const a of asignaciones.data || []) {
    if (!historialPorEquipo.has(a.equipo_id)) historialPorEquipo.set(a.equipo_id, []);
    historialPorEquipo.get(a.equipo_id).push(a);
    if (a.vigente && !vigentePorEquipo.has(a.equipo_id)) vigentePorEquipo.set(a.equipo_id, a);
  }

  const uns = unidades.data || [];
  return {
    equipos: equipos.data || [],
    unidades: uns,
    ordenUnidadIds: uns.map((u) => u.id),
    vigentePorEquipo,
    historialPorEquipo,
    tipoNombrePorId: new Map((tipos.data || []).map((t) => [t.id, t.nombre])),
    tiposCount: (tipos.data || []).length,
  };
}

function filtrar(d) {
  const q = filtros.q.trim().toLowerCase();
  return d.equipos.filter((e) => {
    const vig = d.vigentePorEquipo.get(e.id);
    if (filtros.unidad === "__none__") {
      if (vig) return false;
    } else if (filtros.unidad) {
      if (!vig || String(vig.unidad_operativa_id) !== filtros.unidad) return false;
    }
    if (filtros.estado && norm(e.estado_actual).toLowerCase() !== filtros.estado.toLowerCase()) return false;
    if (q) {
      const heno = [e.modelo, e.no_serie, e.marca, e.codigo, e.nombre, vig?.codigo_asignado]
        .filter(Boolean).join(" ").toLowerCase();
      if (!heno.includes(q)) return false;
    }
    return true;
  });
}

// ------------------------------------------------------------- Filtros
function buildFiltros(d, onChange) {
  const buscar = el("input", {
    class: "input", type: "search", id: "f-eq-buscar", value: filtros.q,
    placeholder: "Modelo, serie, marca…", autocomplete: "off", spellcheck: "false",
    oninput: debounce((e) => { filtros.q = e.target.value; onChange(); }),
  });

  const unidad = buildSearchSelect({
    id: "f-eq-unidad",
    placeholder: "Buscar establecimiento…",
    value: filtros.unidad,
    options: [
      { value: "", label: "Todos los establecimientos" },
      ...d.unidades.map((u) => ({ value: String(u.id), label: u.nombre })),
      { value: "__none__", label: "Sin asignar" },
    ],
    onChange: (v) => { filtros.unidad = v; onChange(); },
  });

  const estados = [...new Set(d.equipos.map((e) => norm(e.estado_actual)).filter(Boolean))].sort();
  const estado = el("select", {
    class: "input", id: "f-eq-estado",
    onchange: (e) => { filtros.estado = e.target.value; onChange(); },
  }, [
    opcion("", "Todos los estados", filtros.estado),
    ...estados.map((s) => opcion(s, s, filtros.estado)),
  ]);

  return el("div", { class: "filters" }, [
    el("div", { class: "filter" }, [el("label", { class: "filter-label", for: "f-eq-buscar", text: "Buscar" }), buscar]),
    el("div", { class: "filter filter--primary" }, [el("label", { class: "filter-label", for: "f-eq-unidad", text: "Establecimiento" }), unidad]),
    el("div", { class: "filter" }, [el("label", { class: "filter-label", for: "f-eq-estado", text: "Estado" }), estado]),
  ]);
}

function opcion(value, texto, actual) {
  const o = el("option", { value, text: texto });
  if (String(value) === String(actual)) o.selected = true;
  return o;
}

// ------------------------------------------------------------- Tarjetas
function construirGrid(filas, d, rerender) {
  if (!filas.length) {
    return el("div", { class: "empty-state" }, [el("p", { text: "Ningún equipo coincide con el filtro." })]);
  }
  const grid = el("div", { class: "card-grid" });
  for (const e of filas) grid.appendChild(tarjeta(e, d, rerender));
  return grid;
}

function tarjeta(e, d, rerender) {
  const vig = d.vigentePorEquipo.get(e.id);
  const historial = d.historialPorEquipo.get(e.id) || [];
  const tipoNombre = d.tipoNombrePorId.get(e.tipo_equipo_id);

  const badges = [
    tagUnidad(vig?.unidad_nombre, vig?.unidad_operativa_id, d.ordenUnidadIds),
    vig?.codigo_asignado ? el("span", { class: "tag tag--codigo", text: vig.codigo_asignado }) : null,
    tipoNombre ? el("span", { class: "tag tag--codigo", text: tipoNombre }) : null,
  ];

  const acc = accionesAsignacion(e, vig, rerender);

  const foot = el("div", { class: "card-tile__foot" }, [
    el("button", {
      class: "btn btn--sm btn--ghost card-tile__hist", type: "button",
      onclick: () => abrirHistorialEquipo(e, historial, d.ordenUnidadIds, acc.onAbrir, acc.onEditar, acc.onCerrar),
      html: `${icon("history", { size: 14, stroke: 1.8 })}<span>Ver historial</span>`,
    }),
    ...(puedeEditar() ? [
      ...botonesAsignacion(vig, acc),
      iconButton("Editar", "btn--ghost", () => openForm(CRUD, e, rerender), "edit"),
      iconButton("Desactivar", "btn--danger-ghost", () => softDelete(CRUD, e, rerender), "deactivate"),
    ] : []),
  ]);

  return el("div", { class: "card-tile" }, [
    el("div", { class: "card-tile__body" }, [
      el("div", { class: "card-tile__head" }, [
        el("div", {}, [
          el("div", { class: "card-tile__title", text: e.modelo || "—" }),
          e.marca ? el("div", { class: "card-tile__brand", text: e.marca }) : null,
        ]),
        e.estado_actual ? badgeEstado(e.estado_actual) : null,
      ]),
      el("div", { class: "card-tile__label", text: "N.º serie" }),
      el("div", { class: "card-tile__serie mono", text: e.no_serie || "—" }),
      e.anio_fabricacion ? el("div", { class: "card-tile__label", text: "Año de fabricación" }) : null,
      e.anio_fabricacion ? el("div", { class: "card-tile__serie mono", text: String(e.anio_fabricacion) }) : null,
      el("div", { class: "card-tile__badges" }, badges),
      e.descripcion ? el("p", { class: "card-tile__desc", text: e.descripcion }) : null,
    ]),
    foot,
  ]);
}


// ------------------------------------------------------------- Tabla
function construirTabla(filas, d, rerender) {
  const columnas = [
    { key: "codigo", label: "Código", render: (e) => el("span", { class: "mono", text: e.codigo || "—" }) },
    { key: "modelo", label: "Modelo" },
    { key: "marca", label: "Marca" },
    { key: "no_serie", label: "No. serie", render: (e) => el("span", { class: "mono", text: e.no_serie || "—" }) },
    { key: "tipo_equipo_id", label: "Tipo", render: (e) => el("span", { text: d.tipoNombrePorId.get(e.tipo_equipo_id) || "—" }) },
    { key: "anio_fabricacion", label: "Año", render: (e) => el("span", { class: "mono", text: e.anio_fabricacion ? String(e.anio_fabricacion) : "—" }) },
    { key: "unidad", label: "Establecimiento", render: (e) => {
        const v = d.vigentePorEquipo.get(e.id);
        return tagUnidad(v?.unidad_nombre, v?.unidad_operativa_id, d.ordenUnidadIds);
      } },
    { key: "codigo_asignado", label: "Cód. asignado", render: (e) => {
        const v = d.vigentePorEquipo.get(e.id);
        return el("span", { class: "mono", text: v?.codigo_asignado || "—" });
      } },
    { key: "estado_actual", label: "Estado", render: (e) => e.estado_actual ? badgeEstado(e.estado_actual) : el("span", { class: "ref__vacio", text: "—" }) },
  ];

  const acciones = (e) => {
    const vig = d.vigentePorEquipo.get(e.id);
    const acc = accionesAsignacion(e, vig, rerender);
    return [
      iconButton("Ver historial", "btn--ghost", () => abrirHistorialEquipo(e, d.historialPorEquipo.get(e.id) || [], d.ordenUnidadIds, acc.onAbrir, acc.onEditar, acc.onCerrar), "history"),
      ...(puedeEditar() ? [
        ...botonesAsignacion(vig, acc),
        iconButton("Editar", "btn--ghost", () => openForm(CRUD, e, rerender), "edit"),
        iconButton("Desactivar", "btn--danger-ghost", () => softDelete(CRUD, e, rerender), "deactivate"),
      ] : []),
    ];
  };

  return buildTable(columnas, filas, acciones);
}

// ------------------------------------------------------------- Utilidades
function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
