import { createCrudView } from "../crud.js";

export default createCrudView({
  table: "estados",
  title: "Estados",
  singular: "estado",
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
