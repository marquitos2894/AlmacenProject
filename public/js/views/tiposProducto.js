import { createCrudView } from "../crud.js";

// Catálogo de tipos de producto (repuesto, consumible, herramienta…). Lo usa
// el formulario de Productos como llave foránea opcional (`tipo_producto_id`).
export default createCrudView({
  table: "tipos_producto",
  title: "Tipos de producto",
  singular: "tipo de producto",
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
