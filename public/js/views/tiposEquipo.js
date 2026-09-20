import { createCrudView } from "../crud.js";

// Catálogo de tipos de equipo (perforadora, jumbo, scoop…). Lo usa el
// formulario de Equipos como llave foránea opcional (`tipo_equipo_id`).
export default createCrudView({
  table: "tipos_equipo",
  title: "Tipos de equipo",
  singular: "tipo de equipo",
  orderBy: "nombre",
  columns: [
    { key: "nombre", label: "Nombre" },
    { key: "descripcion", label: "Descripción" },
  ],
  fields: [
    { name: "nombre", label: "Nombre", type: "text", required: true },
    { name: "descripcion", label: "Descripción", type: "textarea" },
  ],
});
