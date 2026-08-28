import { createCrudView, mensajeError } from "../crud.js";
import { supabase } from "../supabaseClient.js";
import { abrirEtiqueta } from "../barcode.js";
import { abrirHistorial } from "../historialProducto.js";
import { iconButton, el } from "../ui.js";

// Series y códigos se leen mejor en monoespaciada, como el resto de códigos.
const mono = (v) => el("span", { class: "mono", text: v || "—" });
const estadoBadge = (nombre) =>
  nombre ? el("span", { class: "badge badge--estado", text: nombre }) : document.createTextNode("—");

export default createCrudView({
  table: "productos",
  title: "Productos",
  singular: "producto",
  orderBy: "nombre",
  touchUpdatedAt: true,
  // Dos listas separadas: el catálogo a granel y el que se sigue pieza por
  // pieza. Un trazable ES una máquina concreta (dos con series distintas son
  // dos productos), así que su lista muestra serie, código interno y estado,
  // que viven en producto_unidad y llegan unidos por vw_productos_trazables.
  segments: {
    key: "es_trazable",
    label: "Tipo de producto",
    options: [
      { value: false, label: "Consumibles", hint: "se cuentan por cantidad" },
      {
        value: true,
        label: "Componentes",
        hint: "se siguen por número de serie",
        table: "vw_productos_trazables",
        columns: [
          { key: "nombre", label: "Nombre" },
          { key: "no_parte", label: "No. Parte" },
          { key: "no_serie", label: "No. Serie", render: (r) => mono(r.no_serie) },
          { key: "codigo_interno", label: "Código interno", render: (r) => mono(r.codigo_interno) },
          { key: "modelo", label: "Modelo" },
          { key: "marca", label: "Marca" },
          { key: "estado_nombre", label: "Estado", render: (r) => estadoBadge(r.estado_nombre) },
          { key: "equipos_compatible", label: "Equipos compatibles" },
        ],
      },
    ],
  },
  columns: [
    { key: "nombre", label: "Nombre" },
    { key: "no_parte", label: "No. Parte" },
    { key: "marca", label: "Marca" },
    { key: "unidad_medida_id", label: "Unidad" },
    { key: "equipos_compatible", label: "Equipos compatibles" },
  ],
  // Acciones extra junto a Editar / Desactivar. El historial solo aplica a
  // los trazables: en un consumible el movimiento es de cantidades, no de
  // una pieza concreta que se pueda seguir.
  rowActions: (row) => [
    row.es_trazable
      ? iconButton("Movimientos", "btn--ghost", () => abrirHistorial(row))
      : null,
    iconButton("Imprimir", "btn--ghost", () => abrirEtiqueta(row)),
  ].filter(Boolean),
  // El orden importa: primero se decide el tipo, porque de él depende qué
  // campos tienen sentido debajo.
  fields: [
    { name: "nombre", label: "Nombre", type: "text", required: true },
    {
      name: "es_trazable", label: "Es trazable", type: "checkbox",
      hint: "Se sigue pieza por pieza, por su número de serie. Sin marcar, se cuenta por cantidad.",
    },
    {
      name: "no_parte", label: "No. de parte", type: "text",
      hint: "En consumibles no puede repetirse; los trazables sí lo comparten entre unidades.",
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
      showIf: (v) => v.es_trazable === true,
    },
    {
      name: "modelo", label: "Modelo", type: "text", junction: true,
      showIf: (v) => v.es_trazable === true,
    },
    {
      name: "estado_id", label: "Estado", type: "select", junction: true,
      showIf: (v) => v.es_trazable === true,
      source: { table: "estados", value: "id", label: "nombre" },
    },
    {
      name: "codigo_barras",
      label: "Código de barras",
      type: "text",
      placeholder: "Déjalo vacío para generarlo…",
      hint: "Si el producto ya trae uno impreso, escríbelo. Si lo dejas vacío se genera a partir del no. de parte.",
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
      //
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
    async loadRelated(record) {
      const { data } = await supabase
        .from("producto_unidad")
        .select("no_serie, codigo_interno, modelo, estado_id")
        .eq("producto_id", record.id)
        .eq("activo", true)
        .order("id")
        .limit(1)
        .maybeSingle();
      return {
        no_serie: data?.no_serie ?? "",
        codigo_interno: data?.codigo_interno ?? "",
        modelo: data?.modelo ?? "",
        estado_id: data?.estado_id ?? "",
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
        p_estado_id: extra.estado_id || null,
      });
      if (error) throw new Error(mensajeError(error));
    },
  },
});
