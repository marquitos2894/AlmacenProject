import { createCrudView } from "../crud.js";

// Catálogo de proveedores. La tabla, su vista de lista y la FK
// movimientos.id_proveedor ya existen en la base; aquí solo se administra.
export default createCrudView({
  table: "proveedores",
  title: "Proveedores",
  singular: "proveedor",
  orderBy: "razon_social",
  touchUpdatedAt: true,
  columns: [
    { key: "codigo", label: "Código" },
    { key: "razon_social", label: "Razón social" },
    { key: "ruc", label: "RUC" },
    { key: "contacto", label: "Contacto" },
    { key: "telefono", label: "Teléfono" },
    { key: "email", label: "Email" },
  ],
  fields: [
    { name: "codigo", label: "Código", type: "text", hint: "Opcional; si lo usas, no puede repetirse." },
    { name: "razon_social", label: "Razón social", type: "text", required: true },
    { name: "ruc", label: "RUC", type: "text", hint: "Opcional; si lo usas, no puede repetirse." },
    { name: "contacto", label: "Contacto", type: "text" },
    { name: "telefono", label: "Teléfono", type: "text" },
    { name: "email", label: "Email", type: "email" },
    { name: "direccion", label: "Dirección", type: "textarea" },
  ],
});
