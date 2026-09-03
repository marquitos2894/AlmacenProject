// Configuración del formulario de producto (alta y edición).
//
// La usa la vista Productos (`createCrudView`) y también el buscador de
// Movimientos → "Crear producto nuevo", para que ambos den de alta un producto
// con exactamente los mismos campos y la misma lógica de guardado. Editar aquí
// cambia los dos sitios a la vez.
import { supabase } from "./supabaseClient.js";
import { mensajeError } from "./crud.js";

export const productoFormConfig = {
  table: "productos",
  title: "Productos",
  singular: "producto",
  touchUpdatedAt: true,
  formHint: "Primero define el tipo: de él depende qué campos aplican.",
  // El orden importa: primero se decide el tipo, porque de él depende qué
  // campos tienen sentido debajo.
  fields: [
    { name: "nombre", label: "Nombre", type: "text", required: true, full: true },
    {
      name: "es_trazable", label: "Componente", type: "checkbox",
      hint: "Se sigue pieza por pieza, por su número de serie. Sin marcar, se cuenta por cantidad.",
    },
    {
      name: "no_parte", label: "No. de parte", type: "text",
      hint: "En consumibles no puede repetirse; los componentes sí lo comparten entre unidades. Si lo dejas vacío en un consumible se genera uno interno (INT-XXXXX).",
    },
    { name: "marca", label: "Marca", type: "text" },
    // Datos de la máquina concreta. Viven en producto_unidad, no en productos,
    // por eso van marcados como junction: se guardan aparte tras el producto.
    {
      name: "no_serie", label: "No. de serie", type: "text", junction: true,
      showIf: (v) => v.es_trazable === true,
      hint: "Identifica esta unidad; no puede repetirse.",
    },
    {
      name: "codigo_interno", label: "Código interno", type: "text", junction: true,
      readOnly: true,
      showIf: (v) => v.es_trazable === true,
      placeholder: "Se generará (TCH-…)",
      hint: "Se asigna automáticamente con el patrón TCH-XXXXX; no se edita.",
    },
    {
      name: "modelo", label: "Modelo", type: "text", junction: true,
      showIf: (v) => v.es_trazable === true,
      hint: "El estado y la ubicación del componente se editan desde su tarjeta (van en la existencia, no aquí).",
    },
    {
      name: "codigo_barras",
      label: "Código de barras",
      type: "text",
      scan: true,
      placeholder: "Déjalo vacío para generarlo…",
      hint: "En un consumible es el no. de parte; en un componente, su serie (o su código interno). Si escribes uno propio, se respeta.",
    },
    {
      // Solo tiene sentido a granel: una máquina trazable es una pieza, no
      // se mide en litros ni kilos.
      name: "unidad_medida_id",
      label: "Unidad de medida",
      type: "select",
      showIf: (v) => v.es_trazable !== true,
      source: { table: "unidades_medida", value: "id", label: "nombre" },
    },
    { name: "codigo_erp", label: "Código ERP", type: "text" },
    { name: "descripcion", label: "Descripción", type: "textarea" },
    {
      // Se guarda como texto en la propia columna del producto: `equipos` es
      // un catálogo flotante, sin relación con productos. Las opciones salen
      // de vw_equipos_modelos, que agrupa los modelos registrados para que
      // dos unidades del mismo modelo no aparezcan repetidas.
      name: "equipos_compatible",
      label: "Equipos compatibles",
      type: "checklist",
      placeholder: "Buscar modelo…",
      emptyText: "Todavía no hay equipos registrados.",
      source: {
        table: "vw_equipos_modelos",
        value: "modelo",
        label: "modelo",
        filterActive: false, // la vista ya excluye los equipos inactivos
        labelFn: (r) => [r.modelo, r.marca].filter(Boolean).join(" · "),
      },
      // Texto guardado <-> lista de modelos marcados
      parse: (texto) =>
        (texto || "").split(",").map((s) => s.trim()).filter(Boolean),
      serialize: (lista) =>
        Array.isArray(lista) && lista.length ? lista.join(", ") : null,
    },
  ],
  hooks: {
    // Trae los datos de la unidad física para precargarlos en el formulario.
    // El estado ya no vive aquí (va en la existencia, producto_almacen).
    async loadRelated(record) {
      const { data } = await supabase
        .from("producto_unidad")
        .select("no_serie, codigo_interno, modelo")
        .eq("producto_id", record.id)
        .eq("activo", true)
        .order("id")
        .limit(1)
        .maybeSingle();
      return {
        no_serie: data?.no_serie ?? "",
        codigo_interno: data?.codigo_interno ?? "",
        modelo: data?.modelo ?? "",
      };
    },
    // Guarda la unidad en una sola llamada. Si el producto dejó de ser
    // trazable, la función desactiva sus unidades en lugar de borrarlas.
    async afterSave(saved, extra) {
      const { error } = await supabase.rpc("set_producto_unidad", {
        p_producto_id: saved.id,
        p_modelo: extra.modelo || null,
        p_no_serie: extra.no_serie || null,
        p_codigo_interno: extra.codigo_interno || null,
      });
      if (error) throw new Error(mensajeError(error));
    },
  },
};
