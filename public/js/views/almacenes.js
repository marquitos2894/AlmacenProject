import { createCrudView } from "../crud.js";

export default createCrudView({
  table: "almacenes",
  title: "Almacenes",
  singular: "almacén",
  orderBy: "nombre",
  touchUpdatedAt: true,
  columns: [
    { key: "nombre", label: "Nombre" },
    { key: "ubicacion", label: "Ubicación" },
    { key: "descripcion", label: "Descripción" },
  ],
  fields: [
    { name: "nombre", label: "Nombre", type: "text", required: true },
    { name: "ubicacion", label: "Ubicación", type: "text" },
    { name: "descripcion", label: "Descripción", type: "textarea" },
  ],
});
