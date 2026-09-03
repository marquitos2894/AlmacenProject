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
import { el, clear, buildTable, iconButton } from "../ui.js";
import { icon } from "../icons.js";

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
    { name: "no_serie", label: "No. de serie", type: "text" },
    { name: "descripcion", label: "Descripción", type: "textarea" },
  ],
};

// Estado que sobrevive a los re-render.
const filtros = { unidad: "", estado: "", q: "" };
let modoTabla = false;

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
          el("button", {
            class: "btn btn--ghost", type: "button",
            html: `${icon(modoTabla ? "grid" : "table", { size: 15, stroke: 1.9 })}<span>${modoTabla ? "Ver tarjetas" : "Ver tabla"}</span>`,
            onclick: () => { modoTabla = !modoTabla; rerender(); },
          }),
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
    const lista = el("div", {});
    cont.appendChild(buildFiltros(data, () => pintar()));
    cont.appendChild(lista);
    pintar();

    function pintar() {
      clear(lista);
      const filas = filtrar(data);
      lista.appendChild(
        modoTabla ? construirTabla(filas, data, rerender) : construirGrid(filas, data, rerender)
      );
      lista.appendChild(el("p", { class: "list-meta", text: `${filas.length} equipo(s).` }));
    }
  },
};

// ------------------------------------------------------------- Datos
async function cargarDatos() {
  const [equipos, asignaciones, unidades] = await Promise.all([
    supabase.from("equipos").select("*").eq("activo", true).order("modelo"),
    supabase
      .from("vw_equipo_unidad_operativa")
      .select("id, equipo_id, unidad_operativa_id, unidad_nombre, codigo_asignado, estado_id, estado_nombre, fecha_inicio, fecha_fin, horometro_inicial, horometro_final, observacion, vigente")
      .order("fecha_inicio", { ascending: false }),
    supabase.from("unidad_operativa").select("id, nombre").eq("activo", true).order("nombre"),
  ]);

  const err = equipos.error || asignaciones.error || unidades.error;
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

  const unidad = el("select", {
    class: "input", id: "f-eq-unidad",
    onchange: (e) => { filtros.unidad = e.target.value; onChange(); },
  }, [
    opcion("", "Todos los establecimientos", filtros.unidad),
    ...d.unidades.map((u) => opcion(String(u.id), u.nombre, filtros.unidad)),
    opcion("__none__", "Sin asignar", filtros.unidad),
  ]);

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

  const badges = [
    tagUnidad(vig?.unidad_nombre, vig?.unidad_operativa_id, d.ordenUnidadIds),
    vig?.codigo_asignado ? el("span", { class: "tag tag--codigo", text: vig.codigo_asignado }) : null,
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
