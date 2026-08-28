import { createCrudView } from "../crud.js";
import { el } from "../ui.js";

// Valores que vienen de la asignación vigente, no del formulario de equipos.
const derivado = (v) =>
  v ? el("span", { text: v }) : el("span", { class: "ref__vacio", text: "Sin asignar" });

export default createCrudView({
  table: "equipos",
  title: "Equipos",
  singular: "equipo",
  orderBy: "modelo",
  columns: [
    { key: "codigo", label: "Código" },
    { key: "nombre", label: "Nombre" },
    { key: "modelo", label: "Modelo" },
    { key: "marca", label: "Marca" },
    { key: "no_serie", label: "No. Serie" },
    { key: "unidad_actual", label: "Unidad actual", render: (r) => derivado(r.unidad_actual) },
    { key: "estado_actual", label: "Estado actual", render: (r) => derivado(r.estado_actual) },
    { key: "descripcion", label: "Descripción" },
  ],
  fields: [
    { name: "codigo", label: "Código", type: "text", hint: "No puede repetirse entre equipos activos." },
    { name: "nombre", label: "Nombre", type: "text" },
    { name: "modelo", label: "Modelo", type: "text", required: true },
    { name: "marca", label: "Marca", type: "text" },
    { name: "no_serie", label: "No. de serie", type: "text" },
    // `unidad_actual` y `estado_actual` no se capturan aquí: los calcula la
    // base a partir de la asignación más reciente en "Equipos por unidad".
    // Editarlos a mano daría una cifra que el siguiente movimiento pisaría.
    { name: "descripcion", label: "Descripción", type: "textarea" },
  ],
});
