// Historial de asignaciones de un equipo a unidades operativas, en modal de
// consulta. Espejo de historialProducto.js.
import { el, openModal, buildTable, iconButton } from "./ui.js";
import { badgeEstado } from "./badges.js";

// `ordenUnidadIds` da el color estable de cada unidad (mismo criterio que la
// cuadrícula de tarjetas): índice por orden alfabético del catálogo.
// `onNuevaAsignacion` (opcional): añade el botón "+ Nueva asignación" al pie.
// `onEditarAsignacion(fila)` (opcional): añade un botón "Editar" por fila que
// abre el mismo formulario que "Equipos por unidad operativa".
export function abrirHistorialEquipo(equipo, asignaciones, ordenUnidadIds = [], onNuevaAsignacion = null, onEditarAsignacion = null) {
  const titulo = [equipo.modelo, equipo.no_serie].filter(Boolean).join(" / ") || equipo.codigo || "Equipo";
  const body = el("div", { class: "modal__body" });

  const { close } = openModal({
    title: `Historial — ${titulo}`,
    subtitle: "Asignaciones a unidades operativas",
    body,
    submitLabel: "Cerrar",
    readOnly: true,
    size: "wide",
    actions: onNuevaAsignacion
      ? [{
          label: "+ Nueva asignación", class: "btn--ghost",
          // Se cierra el historial antes de abrir el formulario: al guardar, la
          // vista se re-renderiza y este modal quedaría con datos viejos.
          onClick: () => { close(); onNuevaAsignacion(); },
        }]
      : [],
    onSubmit: async (cerrar) => cerrar(),
  });

  const identidad = [
    ["Modelo", equipo.modelo],
    ["Marca", equipo.marca],
    ["N.º serie", equipo.no_serie],
    ["Código", equipo.codigo],
    ["Estado actual", equipo.estado_actual],
  ].filter(([, v]) => v != null && String(v).trim() !== "");

  body.appendChild(
    el("dl", { class: "ticket__meta" },
      identidad.map(([k, v]) => el("div", {}, [el("dt", { text: k }), el("dd", { text: v })]))
    )
  );

  const filas = (asignaciones || []).slice()
    .sort((a, b) => String(b.fecha_inicio || "").localeCompare(String(a.fecha_inicio || "")));

  if (!filas.length) {
    body.appendChild(
      el("div", { class: "empty-state" }, [el("p", { text: "Este equipo todavía no tiene asignaciones." })])
    );
    return;
  }

  const columnas = [
    { key: "unidad_nombre", label: "Unidad operativa", render: (r) => tagUnidad(r.unidad_nombre, r.unidad_operativa_id, ordenUnidadIds) },
    { key: "codigo_asignado", label: "Cód. asignado", render: (r) => el("span", { class: "mono", text: r.codigo_asignado || "—" }) },
    { key: "estado_nombre", label: "Estado", render: (r) => badgeEstado(r.estado_nombre) },
    { key: "fecha_inicio", label: "Desde", render: (r) => fecha(r.fecha_inicio) },
    {
      key: "fecha_fin", label: "Hasta",
      render: (r) => r.fecha_fin ? fecha(r.fecha_fin) : el("span", { class: "badge badge--in", text: "Vigente" }),
    },
    { key: "observacion", label: "Observación" },
  ];

  // Editar una fila: se cierra el historial primero (al guardar, la vista de
  // Equipos se re-renderiza y este modal quedaría con datos viejos).
  const acciones = onEditarAsignacion
    ? (fila) => [iconButton("Editar", "btn--ghost", () => { close(); onEditarAsignacion(fila); }, "edit")]
    : null;

  body.appendChild(buildTable(columnas, filas, acciones));
  body.appendChild(
    el("p", { class: "list-meta", text: `${filas.length} asignación(es) · ${filas.filter((r) => !r.fecha_fin).length} vigente(s).` })
  );
}

export function tagUnidad(nombre, unidadId, ordenUnidadIds = []) {
  if (!unidadId) {
    return el("span", { class: "tag tag--none" }, [el("span", { class: "tag__dot" }), document.createTextNode("Sin asignar")]);
  }
  const i = ordenUnidadIds.indexOf(unidadId);
  const clase = `tag tag--c${((i < 0 ? 0 : i) % 8) + 1}`;
  return el("span", { class: clase }, [el("span", { class: "tag__dot" }), document.createTextNode(nombre || "Unidad")]);
}

function fecha(f) {
  if (!f) return "—";
  const [y, m, d] = String(f).slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat(navigator.language || "es-MX", { dateStyle: "medium" })
    .format(new Date(y, m - 1, d));
}
