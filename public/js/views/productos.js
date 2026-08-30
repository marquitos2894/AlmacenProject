import { createCrudView, mensajeError } from "../crud.js";
import { supabase } from "../supabaseClient.js";
import { abrirEtiqueta } from "../barcode.js";
import { abrirHistorial } from "../historialProducto.js";
import { badgeEstado, badgeAlmacen } from "../badges.js";
import { abrirCambioEstado } from "../cambioEstadoExistencia.js";
import { iconButton, el } from "../ui.js";
import { icon } from "../icons.js";

// Series y códigos se leen mejor en monoespaciada, como el resto de códigos.
const mono = (v) => el("span", { class: "mono", text: v || "—" });

// Abre el modal de estado/ubicación de un componente si tiene existencia.
function editarEstadoComponente(row, onDone) {
  if (!row.producto_almacen_id) return; // sin existencia todavía (botón deshabilitado)
  abrirCambioEstado({
    productoAlmacenId: row.producto_almacen_id,
    nombre: [row.nombre, row.no_serie].filter(Boolean).join(" · "),
    estadoActualId: row.estado_id,
    ubicacionActual: row.ubicacion,
    onDone,
  });
}

// Tarjeta de componente (producto trazable), al estilo de la vista Equipos.
function tarjetaComponente(row, { editable, editar, desactivar, rerender }) {
  const unidades = Number(row.unidades) || 0;
  const compatibles = (row.equipos_compatible || "").split(",").map((s) => s.trim()).filter(Boolean);
  const conExistencia = !!row.producto_almacen_id;

  const btnEstado = iconButton(
    conExistencia ? "Editar estado y ubicación" : "Sin existencia: registra una entrada primero",
    "btn--ghost", () => editarEstadoComponente(row, rerender), "estados"
  );
  if (!conExistencia) btnEstado.disabled = true;

  const foot = el("div", { class: "card-tile__foot" }, [
    el("button", {
      class: "btn btn--sm btn--ghost card-tile__hist", type: "button",
      onclick: () => abrirHistorial(row),
      html: `${icon("history", { size: 14, stroke: 1.8 })}<span>Ver movimientos</span>`,
    }),
    ...(editable ? [btnEstado] : []),
    iconButton("Imprimir etiqueta", "btn--ghost", () => abrirEtiqueta(row), "print"),
    ...(editable ? [
      iconButton("Editar", "btn--ghost", () => editar(row), "edit"),
      iconButton("Desactivar", "btn--danger-ghost", () => desactivar(row), "deactivate"),
    ] : []),
  ]);

  return el("div", { class: "card-tile" }, [
    el("div", { class: "card-tile__body" }, [
      el("div", { class: "card-tile__head" }, [
        el("div", {}, [
          el("div", { class: "card-tile__title", text: row.nombre || "—" }),
          row.marca ? el("div", { class: "card-tile__brand", text: row.marca }) : null,
        ]),
        badgeEstado(row.estado_nombre),
      ]),
      el("div", { class: "card-tile__label", text: "N.º parte" }),
      el("div", { class: "card-tile__serie mono", text: row.no_parte || "—" }),
      row.no_serie ? el("div", { class: "card-tile__label", text: "N.º serie" }) : null,
      row.no_serie ? el("div", { class: "card-tile__serie mono", text: row.no_serie }) : null,
      el("div", { class: "card-tile__label", text: "Ubicación actual" }),
      el("div", { class: "card-tile__loc" }, conExistencia
        ? [
            row.ubicacion ? document.createTextNode(`${row.ubicacion} `) : null,
            badgeAlmacen(row.almacen_nombre),
          ]
        : [document.createTextNode("Sin existencia registrada")]),
      el("div", { class: "card-tile__badges" }, [
        el("span", { class: "tag tag--codigo", text: `${unidades} unidad${unidades === 1 ? "" : "es"}` }),
        ...compatibles.slice(0, 4).map((m) => el("span", { class: "tag tag--codigo", text: m })),
        compatibles.length > 4 ? el("span", { class: "tag tag--none", text: `+${compatibles.length - 4}` }) : null,
      ]),
      row.descripcion ? el("p", { class: "card-tile__desc", text: row.descripcion }) : null,
    ]),
    foot,
  ]);
}

export default createCrudView({
  table: "productos",
  title: "Productos",
  singular: "producto",
  orderBy: "nombre",
  touchUpdatedAt: true,
  formHint: "Primero define el tipo: de él depende qué campos aplican.",
  search: {
    fields: ["nombre", "no_parte", "marca"],
    placeholder: "Buscar por nombre, n.º de parte, serie…",
  },
  // Dos listas separadas: el catálogo a granel y el que se sigue pieza por
  // pieza. Un trazable ES una máquina concreta (dos con series distintas son
  // dos productos). Su estado y ubicación actuales salen de su existencia
  // (producto_almacen), no del formulario: llegan por vw_productos_trazables.
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
        searchFields: ["nombre", "no_parte", "marca", "no_serie", "codigo_interno"],
        card: (row, ctx) => tarjetaComponente(row, ctx),
        columns: [
          { key: "nombre", label: "Nombre" },
          { key: "no_parte", label: "No. Parte" },
          { key: "no_serie", label: "No. Serie", render: (r) => mono(r.no_serie) },
          { key: "modelo", label: "Modelo" },
          { key: "marca", label: "Marca" },
          { key: "estado_nombre", label: "Estado", render: (r) => badgeEstado(r.estado_nombre) },
          {
            key: "ubicacion", label: "Ubicación actual",
            render: (r) => r.producto_almacen_id
              ? el("span", {}, [
                  r.ubicacion ? document.createTextNode(`${r.ubicacion} `) : null,
                  badgeAlmacen(r.almacen_nombre),
                ])
              : el("span", { text: "—" }),
          },
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
  rowActions: (row, rerender) => [
    row.es_trazable
      ? iconButton("Movimientos", "btn--ghost", () => abrirHistorial(row), "history")
      : null,
    row.es_trazable && row.producto_almacen_id
      ? iconButton("Editar estado y ubicación", "btn--ghost", () => abrirCambioEstado({
          productoAlmacenId: row.producto_almacen_id,
          nombre: [row.nombre, row.no_serie].filter(Boolean).join(" · "),
          estadoActualId: row.estado_id, ubicacionActual: row.ubicacion, onDone: rerender,
        }), "estados")
      : null,
    iconButton("Imprimir etiqueta", "btn--ghost", () => abrirEtiqueta(row), "print"),
  ].filter(Boolean),
  // El orden importa: primero se decide el tipo, porque de él depende qué
  // campos tienen sentido debajo.
  fields: [
    { name: "nombre", label: "Nombre", type: "text", required: true, full: true },
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
      hint: "El estado y la ubicación del componente se editan desde su tarjeta (van en la existencia, no aquí).",
    },
    {
      name: "codigo_barras",
      label: "Código de barras",
      type: "text",
      full: true,
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
});
