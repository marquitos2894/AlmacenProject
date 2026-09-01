import { createCrudView } from "../crud.js";
import { productoFormConfig } from "../productoForm.js";
import { abrirEtiqueta } from "../barcode.js";
import { abrirHistorial } from "../historialProducto.js";
import { badgeEstado, badgeAlmacen, badgeChip } from "../badges.js";
import { abrirCambioEstado } from "../cambioEstadoExistencia.js";
import { iconButton, el } from "../ui.js";
import { icon } from "../icons.js";

// Series y códigos se leen mejor en monoespaciada, como el resto de códigos.
const mono = (v) => el("span", { class: "mono", text: v || "—" });

// Ubicación actual de un componente:
//  - con existencia: ubicación + almacén;
//  - sin existencia (salió por completo del inventario): dos chips con a qué
//    unidad operativa y equipo (modelo/serie/código asignado) se fue, según su
//    última salida (vw_productos_trazables los trae);
//  - si nunca tuvo existencia: "Sin existencia registrada".
function nodosUbicacionComponente(row) {
  if (row.producto_almacen_id) {
    return [
      row.ubicacion ? document.createTextNode(`${row.ubicacion} `) : null,
      badgeAlmacen(row.almacen_nombre),
    ];
  }
  if (row.salida_unidad_operativa || row.salida_equipo) {
    return [
      el("span", { class: "loc-chips" }, [
        row.salida_unidad_operativa ? badgeChip(row.salida_unidad_operativa) : null,
        row.salida_equipo ? el("span", { class: "tag tag--codigo", text: row.salida_equipo }) : null,
      ]),
    ];
  }
  return [document.createTextNode("Sin existencia registrada")];
}

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
      el("div", { class: "card-tile__loc" }, nodosUbicacionComponente(row)),
      el("div", { class: "card-tile__badges" }, [
        // La cuenta de unidades solo tiene sentido si el componente está en
        // inventario; sin existencia se oculta.
        conExistencia
          ? el("span", { class: "tag tag--codigo", text: `${unidades} unidad${unidades === 1 ? "" : "es"}` })
          : null,
        ...compatibles.slice(0, 4).map((m) => el("span", { class: "tag tag--codigo", text: m })),
        compatibles.length > 4 ? el("span", { class: "tag tag--none", text: `+${compatibles.length - 4}` }) : null,
      ]),
      row.descripcion ? el("p", { class: "card-tile__desc", text: row.descripcion }) : null,
    ]),
    foot,
  ]);
}

export default createCrudView({
  // Campos del formulario y lógica de guardado se comparten con el buscador de
  // Movimientos → "Crear producto nuevo" (public/js/productoForm.js).
  ...productoFormConfig,
  orderBy: "nombre",
  search: {
    fields: ["nombre", "no_parte", "marca", "codigo_barras"],
    placeholder: "Buscar por nombre, n.º de parte, código…",
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
        searchFields: ["nombre", "no_parte", "marca", "no_serie", "codigo_interno", "codigo_barras"],
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
            render: (r) => el("span", {}, nodosUbicacionComponente(r)),
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
  // `fields` y `hooks` vienen de productoFormConfig (ver el spread de arriba).
});
