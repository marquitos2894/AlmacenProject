import { createCrudView } from "../crud.js";

export default createCrudView({
  table: "unidades_medida",
  title: "Unidades de medida",
  singular: "unidad de medida",
  orderBy: "codigo",
  columns: [
    { key: "codigo", label: "Código" },
    { key: "nombre", label: "Nombre" },
  ],
  fields: [
    { name: "codigo", label: "Código", type: "text", required: true },
    { name: "nombre", label: "Nombre", type: "text", required: true },
  ],
});
