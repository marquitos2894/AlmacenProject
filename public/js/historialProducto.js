// Historial de movimientos de un producto, en modal de consulta.
//
// Un producto aparece en un movimiento por dos vías y la vista reúne ambas:
// como renglón del carrito, o como el activo referenciado en la cabecera.
import { supabase } from "./supabaseClient.js";
import { el, clear, openModal, buildTable, imprimirZona } from "./ui.js";
import { badgeEstado, badgeAlmacen } from "./badges.js";

export function abrirHistorial(producto) {
  const body = el("div", { class: "modal__body" }, [
    el("p", { class: "loading", text: "Cargando movimientos…" }),
  ]);

  openModal({
    title: `Movimientos — ${producto.nombre}`,
    body,
    submitLabel: "Cerrar",
    readOnly: true,
    size: "wide",
    actions: [{ label: "Imprimir", onClick: () => imprimirZona() }],
    onSubmit: async (cerrar) => cerrar(),
  });

  cargar();

  async function cargar() {
    const { data, error } = await supabase
      .from("vw_producto_movimientos")
      .select("*")
      .eq("producto_id", producto.id)
      .order("fecha", { ascending: false })
      .order("movimiento_id", { ascending: false })
      .limit(300);

    clear(body);

    if (error) {
      body.appendChild(
        el("div", { class: "alert alert--error", text: `No se pudo cargar el historial: ${error.message}` })
      );
      return;
    }

    const filas = data || [];
    const hoja = el("div", { class: "ticket zona-impresion" });

    // Identificación del producto, para que el impreso se entienda solo.
    const identidad = [
      ["Producto", producto.nombre],
      ["No. parte", producto.no_parte],
      ["No. serie", producto.no_serie],
      ["Código interno", producto.codigo_interno],
    ].filter(([, v]) => v != null && String(v).trim() !== "");

    hoja.appendChild(
      el("dl", { class: "ticket__meta" },
        identidad.map(([k, v]) => el("div", {}, [el("dt", { text: k }), el("dd", { text: v })]))
      )
    );

    if (!filas.length) {
      hoja.appendChild(
        el("div", { class: "empty-state" }, [
          el("p", { text: "Este producto todavía no tiene movimientos." }),
        ])
      );
      body.appendChild(hoja);
      return;
    }

    const columnas = [
      { key: "folio", label: "Folio", render: (r) => el("span", { class: "folio-tag mono", text: r.folio }) },
      { key: "fecha", label: "Fecha", render: (r) => formatFecha(r.fecha) },
      { key: "tipo_movimiento", label: "Tipo", render: tipoBadge },
      { key: "cantidad", label: "Cantidad", render: (r) => num(r.cantidad) },
      { key: "almacen_nombre", label: "Almacén", render: (r) => badgeAlmacen(r.almacen_nombre) },
      { key: "ubicacion", label: "Ubicación", render: (r) => mono(r.ubicacion) },
      { key: "estado_nombre", label: "Estado", render: (r) => badgeEstado(r.estado_nombre) },
      { key: "unidad_operativa_nombre", label: "Establecimiento" },
      { key: "equipo_etiqueta", label: "Equipo", render: (r) => mono(r.equipo_etiqueta) },
      { key: "motivo", label: "Motivo" },

    ];

    hoja.appendChild(buildTable(columnas, filas, null));

    // Balance: cuánto entró y cuánto salió, contando solo los renglones
    // (los movimientos donde el producto solo va referenciado no mueven stock).
    const suma = (tipo) => filas
      .filter((r) => r.origen === "Renglón" && r.tipo_movimiento === tipo)
      .reduce((s, r) => s + Number(r.cantidad || 0), 0);
    const entradas = suma("entrada");
    const salidas = suma("salida");

    hoja.appendChild(
      el("dl", { class: "totals" }, [
        el("div", {}, [el("dt", { text: "Movimientos" }), el("dd", { class: "mono", text: String(filas.length) })]),
        el("div", {}, [el("dt", { text: "Entradas" }), el("dd", { class: "mono", text: String(entradas) })]),
        el("div", {}, [el("dt", { text: "Salidas" }), el("dd", { class: "mono", text: String(salidas) })]),
      ])
    );

    body.appendChild(hoja);
  }
}

// -------- utilidades locales
function mono(v) {
  return el("span", { class: "mono", text: v || "—" });
}
function num(v) {
  return el("span", { class: "mono", text: v == null ? "—" : String(v) });
}
function tipoBadge(row) {
  if (row.es_stock_inicial) return el("span", { class: "badge badge--inicial", text: "Stock inicial" });
  const salida = row.tipo_movimiento === "salida";
  return el("span", { class: `badge ${salida ? "badge--out" : "badge--in"}`, text: salida ? "Salida" : "Entrada" });
}
function formatFecha(f) {
  if (!f) return "—";
  // 'YYYY-MM-DD' se interpreta como UTC; se arma local para no desfasar el día.
  const [y, m, d] = String(f).slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat(navigator.language || "es-MX", { dateStyle: "medium" })
    .format(new Date(y, m - 1, d));
}
