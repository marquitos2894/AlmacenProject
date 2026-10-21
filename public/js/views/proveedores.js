import { createCrudView } from "../crud.js";
import { el } from "../ui.js";

const mono = (v) => el("span", { class: "mono", text: v || "—" });

// Catálogo de proveedores. La tabla, su vista de lista y la FK
// movimientos.id_proveedor se definen en la migración 0060; aquí solo se administra.
export default createCrudView({
  table: "proveedores",
  title: "Proveedores",
  singular: "proveedor",
  orderBy: "razon_social",
  touchUpdatedAt: true,
  search: {
    placeholder: "Buscar por razón social, código, RUC o contacto…",
    fields: ["razon_social", "codigo", "ruc", "contacto", "email"],
  },
  columns: [
    { key: "codigo", label: "Código", render: (r) => mono(r.codigo) },
    { key: "razon_social", label: "Razón social" },
    { key: "ruc", label: "RUC", render: (r) => mono(r.ruc) },
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
