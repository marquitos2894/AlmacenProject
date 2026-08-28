import { createCrudView } from "../crud.js";

// Unidades operativas: los proyectos mineros en distintos lugares del Perú.
export default createCrudView({
  table: "unidad_operativa",
  title: "Unidades operativas",
  singular: "unidad operativa",
  orderBy: "nombre",
  touchUpdatedAt: true,
  columns: [
    { key: "codigo", label: "Código" },
    { key: "nombre", label: "Nombre" },
    { key: "proyecto", label: "Proyecto" },
    { key: "ubicacion", label: "Ubicación" },
    { key: "zona", label: "Zona" },
  ],
  fields: [
    {
      name: "codigo", label: "Código", type: "text",
      hint: "No puede repetirse entre unidades activas.",
    },
    { name: "nombre", label: "Nombre", type: "text", required: true },
    { name: "proyecto", label: "Proyecto", type: "text" },
    { name: "ubicacion", label: "Ubicación", type: "text", placeholder: "Departamento, provincia…" },
    { name: "zona", label: "Zona", type: "text" },
  ],
});
