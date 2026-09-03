import { createCrudView } from "../crud.js";

// Establecimientos: los proyectos mineros (unidades operativas) y los
// establecimientos de transición. La tabla sigue siendo `unidad_operativa`.
// La lista se parte en dos pestañas sobre `tipo_de_establecimiento`; al crear
// desde una pestaña, el registro nace con ese tipo.
const TIPOS = [
  { value: "unidad_operativa", label: "Unidad operativa" },
  { value: "establecimiento_transicion", label: "Establecimiento de transición" },
];

export default createCrudView({
  table: "unidad_operativa",
  title: "Establecimientos",
  singular: "establecimiento",
  orderBy: "nombre",
  touchUpdatedAt: true,
  segments: {
    key: "tipo_de_establecimiento",
    label: "Tipo de establecimiento",
    options: [
      { value: "unidad_operativa", label: "Unidades operativas", hint: "proyectos mineros" },
      { value: "establecimiento_transicion", label: "Establecimientos de transición" },
    ],
  },
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
      hint: "No puede repetirse entre establecimientos activos.",
    },
    { name: "nombre", label: "Nombre", type: "text", required: true },
    {
      name: "tipo_de_establecimiento", label: "Tipo de establecimiento",
      type: "select", required: true, options: TIPOS,
    },
    { name: "proyecto", label: "Proyecto", type: "text" },
    { name: "ubicacion", label: "Ubicación", type: "text", placeholder: "Departamento, provincia…" },
    { name: "zona", label: "Zona", type: "text" },
  ],
});
