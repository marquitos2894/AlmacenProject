import { createCrudView } from "../crud.js";
import { el } from "../ui.js";

// Asignaciones de equipos a unidades operativas. Es un historial: una fila
// sin fecha de fin es la asignación vigente, y la base impide que un mismo
// equipo tenga dos abiertas a la vez.
export default createCrudView({
  table: "equipo_unidad_operativa",
  title: "Equipos por unidad operativa",
  singular: "asignación",
  orderBy: "fecha_inicio",
  touchUpdatedAt: true,
  columns: [
    { key: "equipo_id", label: "Equipo" },
    { key: "unidad_operativa_id", label: "Unidad operativa" },
    {
      key: "codigo_asignado", label: "Código asignado",
      render: (r) => el("span", { class: "mono", text: r.codigo_asignado || "—" }),
    },
    { key: "fecha_inicio", label: "Desde", render: (r) => fecha(r.fecha_inicio) },
    {
      key: "fecha_fin", label: "Hasta",
      render: (r) => r.fecha_fin
        ? fecha(r.fecha_fin)
        : el("span", { class: "badge badge--in", text: "Vigente" }),
    },
    { key: "estado_id", label: "Estado" },
    { key: "observacion", label: "Observación" },
  ],
  fields: [
    {
      name: "equipo_id", label: "Equipo", type: "select", required: true,
      source: {
        table: "equipos", value: "id", label: "modelo",
        labelFn: (r) => [r.codigo, r.modelo, r.no_serie].filter(Boolean).join(" · "),
      },
    },
    {
      name: "unidad_operativa_id", label: "Unidad operativa", type: "select", required: true,
      source: {
        table: "unidad_operativa", value: "id", label: "nombre",
        labelFn: (r) => [r.codigo, r.nombre].filter(Boolean).join(" · "),
      },
    },
    {
      name: "codigo_asignado", label: "Código asignado", type: "text",
      placeholder: "No. de flota, código interno del proyecto…",
      hint: "El código que lleva el equipo mientras está en esa unidad. No puede repetirse entre asignaciones vigentes de la misma unidad.",
    },
    { name: "fecha_inicio", label: "Fecha de inicio", type: "date", required: true },
    {
      name: "fecha_fin", label: "Fecha de fin", type: "date",
      hint: "Déjala vacía mientras el equipo siga en esa unidad.",
    },
    {
      name: "estado_id", label: "Estado", type: "select",
      source: { table: "estados", value: "id", label: "nombre" },
      hint: "El equipo hereda este estado como su estado actual.",
    },
    { name: "observacion", label: "Observación", type: "textarea" },
  ],
});

function fecha(f) {
  if (!f) return "—";
  const [y, m, d] = String(f).slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat(navigator.language || "es-MX", { dateStyle: "medium" })
    .format(new Date(y, m - 1, d));
}
