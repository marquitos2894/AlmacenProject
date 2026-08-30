// Movimientos — flujo de 3 pasos:
//   #/movimientos              → elegir almacén
//   #/movimientos/{id}         → tickets de ese almacén
//   #/movimientos/{id}/nuevo   → capturar ticket (carrito)
import { supabase } from "../supabaseClient.js";
import { getCurrentUsuario, puedeEditar } from "../auth.js";
import { openProductSearch } from "../productSearch.js";
import { openPicker, PICKER_PROD_ACTIVO, PICKER_EQUIPO, PICKER_UNIDAD_OPERATIVA, PICKER_PROVEEDOR } from "../pickerModal.js";
import { renderBarcodeLabel } from "../barcode.js";
import { icon } from "../icons.js";
import { el, clear, toast, openModal, buildField, readField, buildTable, iconButton, imprimirZona } from "../ui.js";

const LOGO_EMPRESA = "img/logo/corimayologo.png";

const filtros = { no_parte: "", nombre: "", estado_id: "" };

export default {
  async render(root, params = []) {
    const [almacenId, sub] = params;
    if (!almacenId) return renderPicker(root);
    if (sub === "nuevo") return renderForm(root, Number(almacenId));
    return renderList(root, Number(almacenId));
  },
};

// =====================================================================
// Paso 1 — Elegir almacén
// =====================================================================
async function renderPicker(root) {
  clear(root);
  root.appendChild(
    el("div", { class: "page-header" }, [
      el("div", {}, [
        el("h2", { class: "page-title", text: "Movimientos" }),
        el("p", { class: "page-subtitle", text: "Elige el almacén sobre el que vas a trabajar." }),
      ]),
    ])
  );

  const grid = el("div", { class: "wh-grid" }, [el("p", { class: "loading", text: "Cargando almacenes…" })]);
  root.appendChild(grid);

  const { data, error } = await supabase
    .from("almacenes").select("*").eq("activo", true).order("nombre");

  clear(grid);
  if (error) {
    grid.appendChild(el("div", { class: "alert alert--error", text: `No se pudieron cargar los almacenes: ${error.message}` }));
    return;
  }
  if (!data?.length) {
    grid.appendChild(
      el("div", { class: "empty-state" }, [
        el("p", { text: "Todavía no hay almacenes." }),
        el("a", { class: "btn btn--primary", href: "#/almacenes", text: "Crear un almacén" }),
      ])
    );
    return;
  }

  // Conteo de existencias por almacén, en una sola consulta
  const { data: stocks } = await supabase
    .from("producto_almacen").select("almacen_id").eq("activo", true);
  const conteo = new Map();
  for (const s of stocks || []) conteo.set(s.almacen_id, (conteo.get(s.almacen_id) || 0) + 1);

  for (const a of data) {
    grid.appendChild(
      el("a", { class: "wh-card", href: `#/movimientos/${a.id}` }, [
        el("span", { class: "wh-card__icon", "aria-hidden": "true", html: icon("almacenes", { size: 24, stroke: 1.7 }) }),
        el("span", { class: "wh-card__name", text: a.nombre }),
        el("span", { class: "wh-card__meta", text: a.ubicacion || "Sin ubicación" }),
        el("span", { class: "wh-card__count mono", text: `${conteo.get(a.id) || 0} artículos` }),
      ])
    );
  }
}

// =====================================================================
// Paso 2 — Tickets del almacén
// =====================================================================
async function renderList(root, almacenId) {
  clear(root);
  const almacen = await getAlmacen(almacenId);
  if (!almacen) {
    root.appendChild(el("div", { class: "alert alert--error", text: "Ese almacén no existe." }));
    return;
  }

  root.appendChild(
    el("div", { class: "page-header" }, [
      el("div", {}, [
        el("a", { class: "backlink", href: "#/movimientos", text: "← Cambiar de almacén" }),
        el("h2", { class: "page-title", text: "Movimientos" }),
        el("p", { class: "page-subtitle", text: `Almacén ${almacen.nombre}` }),
      ]),
      puedeEditar()
        ? el("a", { class: "btn btn--primary", href: `#/movimientos/${almacenId}/nuevo`, text: "+ Nuevo movimiento" })
        : null,
    ])
  );

  const lista = el("div", { class: "card" });
  const estados = await loadEstados();
  root.appendChild(buildFiltros(estados, () => cargar()));
  root.appendChild(lista);
  await cargar();

  async function cargar() {
    clear(lista);
    lista.appendChild(el("p", { class: "loading", text: "Cargando…" }));

    let q = supabase.from("vw_movimientos").select("*").eq("almacen_id", almacenId);
    if (filtros.no_parte) q = q.ilike("busq_no_parte", `%${filtros.no_parte}%`);
    if (filtros.nombre) q = q.ilike("busq_nombre", `%${filtros.nombre}%`);
    if (filtros.estado_id) q = q.contains("estado_ids", [Number(filtros.estado_id)]);
    q = q.order("created_at", { ascending: false }).limit(200);

    const { data, error } = await q;
    clear(lista);
    if (error) {
      lista.appendChild(el("div", { class: "alert alert--error", text: `No se pudieron cargar los movimientos: ${error.message}` }));
      return;
    }

    const columnas = [
      { key: "folio", label: "Folio", render: (r) => el("span", { class: "folio-tag mono", text: r.folio }) },
      { key: "fecha", label: "Fecha", render: (r) => formatFecha(r.fecha) },
      { key: "tipo_movimiento", label: "Tipo", render: tipoBadge },
      { key: "productos_resumen", label: "Producto" },
      //{ key: "total_items", label: "Renglones", render: (r) => numCell(r.total_items) },
      { key: "total_cantidad", label: "Cantidad", render: (r) => numCell(r.total_cantidad) },
      { key: "motivo", label: "Motivo" },
      //{ key: "usuario_nombre", label: "Registró" },
    ];

    lista.appendChild(
      buildTable(columnas, data || [], (row) => [
        iconButton("Ver ticket", "btn--ghost", () => verTicket(row), "ticket"),
      ])
    );
    lista.appendChild(el("p", { class: "list-meta", text: `${(data || []).length} movimiento(s).` }));
  }
}

function buildFiltros(estados, onChange) {
  const noParte = el("input", {
    class: "input", type: "search", id: "f-no-parte", value: filtros.no_parte,
    placeholder: "No. de parte…", autocomplete: "off", spellcheck: "false",
    oninput: debounce((e) => { filtros.no_parte = e.target.value; onChange(); }),
  });
  const nombre = el("input", {
    class: "input", type: "search", id: "f-nombre", value: filtros.nombre,
    placeholder: "Nombre…", autocomplete: "off",
    oninput: debounce((e) => { filtros.nombre = e.target.value; onChange(); }),
  });
  const estado = el("select", {
    class: "input", id: "f-estado",
    onchange: (e) => { filtros.estado_id = e.target.value; onChange(); },
  }, [
    el("option", { value: "", text: "Todos los estados" }),
    ...estados.map((s) => {
      const o = el("option", { value: String(s.id), text: s.nombre });
      if (String(s.id) === String(filtros.estado_id)) o.selected = true;
      return o;
    }),
  ]);

  return el("div", { class: "filters" }, [
    filtro("f-no-parte", "No. de parte", noParte),
    filtro("f-nombre", "Nombre", nombre),
    filtro("f-estado", "Estado", estado),
  ]);
}

function filtro(id, label, control) {
  return el("div", { class: "filter" }, [
    el("label", { class: "filter-label", for: id, text: label }),
    control,
  ]);
}

// =====================================================================
// Paso 3 — Capturar el ticket (carrito)
// =====================================================================
async function renderForm(root, almacenId) {
  clear(root);
  const almacen = await getAlmacen(almacenId);
  if (!almacen) {
    root.appendChild(el("div", { class: "alert alert--error", text: "Ese almacén no existe." }));
    return;
  }
  if (!puedeEditar()) {
    root.appendChild(
      el("div", { class: "page-header" }, [
        el("div", {}, [
          el("a", { class: "backlink", href: `#/movimientos/${almacenId}`, text: "← Volver a movimientos" }),
          el("h2", { class: "page-title", text: "Nuevo movimiento" }),
        ]),
      ])
    );
    root.appendChild(el("div", { class: "alert alert--error", text: "Tu cuenta es de solo lectura: no puedes registrar movimientos." }));
    return;
  }

  const carrito = [];

  root.appendChild(
    el("div", { class: "page-header" }, [
      el("div", {}, [
        el("a", { class: "backlink", href: `#/movimientos/${almacenId}`, text: "← Volver a movimientos" }),
        el("h2", { class: "page-title", text: "Nuevo movimiento" }),
        el("p", { class: "page-subtitle", text: `Almacén ${almacen.nombre}` }),
      ]),
    ])
  );

  // ---- Encabezado del ticket
  const campos = [
    { name: "fecha", label: "Fecha", type: "date", required: true },
    { name: "tipo_movimiento", label: "Tipo de movimiento", type: "select", required: true, options: [
      { value: "entrada", label: "Entrada (+)" },
      { value: "salida", label: "Salida (−)" },
    ] },
    { name: "motivo", label: "Motivo", type: "text", placeholder: "Compra, traspaso, ajuste…" },
    { name: "observaciones", label: "Observaciones", type: "textarea" },
  ];

  const grid = el("div", { class: "form-grid" });
  const inputs = {};
  for (const f of campos) {
    const valor = f.name === "fecha" ? hoy() : f.name === "tipo_movimiento" ? "entrada" : "";
    const { wrap, input } = buildField(f, valor);
    if (f.name === "observaciones") wrap.classList.add("form-grid__full");
    grid.appendChild(wrap);
    inputs[f.name] = input;
  }

  // Stock inicial
  const chkInicial = el("input", { type: "checkbox", id: "es-stock-inicial", class: "checkbox" });
  const tipoSel = inputs.tipo_movimiento;
  chkInicial.addEventListener("change", () => {
    if (chkInicial.checked) {
      tipoSel.value = "entrada";
      tipoSel.disabled = true;
    } else {
      tipoSel.disabled = false;
    }
    vaciarSiCambiaModo();
  });

  // Entradas y salidas capturan cosas distintas (una elige producto, la otra
  // una existencia concreta), así que un carrito mixto no tendría sentido.
  tipoSel.addEventListener("change", vaciarSiCambiaModo);

  function vaciarSiCambiaModo() {
    if (carrito.length) {
      carrito.length = 0;
      toast("Se vació el ticket porque cambió el tipo de movimiento.", "info");
    }
    pintarCarrito();
  }

  const bloqueInicial = el("div", { class: "switch-row" }, [
    chkInicial,
    el("div", {}, [
      el("label", { class: "form-label", for: "es-stock-inicial", text: "Este movimiento es un Stock Inicial" }),
      el("p", { class: "form-hint", text: "Reemplaza la existencia con ese estado y ubicación, en vez de sumarle. Las demás existencias del producto no se tocan." }),
    ]),
  ]);

  // Catálogo de estados para el buscador y el carrito
  const estados = await loadEstados();

  // ---- Referencias opcionales del ticket: a qué unidad y a qué equipo va.
  // Se eligen en un modal con filtro, no en un desplegable: estas listas
  // crecen y buscar por serie o código es más rápido que recorrerlas.
  const referencias = { id_producto_unidad: null, id_equipo: null, id_unidad_operativa: null, id_proveedor: null };

  const refUnidad = buildReferencia({
    etiqueta: "Producto Activo", icono: "wrench", textoBoton: "Elegir producto activo",
    config: PICKER_PROD_ACTIVO,
    onElegir: (row) => { referencias.id_producto_unidad = row?.id ?? null; },
    describir: (row) => row.descripcion || row.producto_nombre,
  });

  const refProveedor = buildReferencia({
    etiqueta: "Proveedor", icono: "proveedores", textoBoton: "Elegir proveedor",
    config: PICKER_PROVEEDOR,
    onElegir: (row) => { referencias.id_proveedor = row?.id ?? null; },
    describir: (row) => row.etiqueta || row.razon_social,
  });

  const refEquipo = buildReferencia({
    etiqueta: "Equipo", icono: "equipos", textoBoton: "Elegir equipo",
    config: PICKER_EQUIPO,
    onElegir: (row) => { referencias.id_equipo = row?.id ?? null; },
    describir: (row) => row.etiqueta || row.modelo,
  });

  const refUnidadOperativa = buildReferencia({
    etiqueta: "Unidad operativa", icono: "unidades-operativas", textoBoton: "Elegir unidad operativa",
    config: PICKER_UNIDAD_OPERATIVA,
    onElegir: (row) => { referencias.id_unidad_operativa = row?.id ?? null; },
    describir: (row) => row.etiqueta || row.nombre,
  });

  root.appendChild(
    el("section", { class: "card card--pad" }, [
      el("h3", { class: "section-title", text: "Datos del movimiento" }),
      grid,
      bloqueInicial,
      el("div", { class: "refs" }, [refUnidad.nodo, refProveedor.nodo, refEquipo.nodo, refUnidadOperativa.nodo]),
    ])
  );

  // ---- Carrito
  const cuerpoCarrito = el("div", { class: "cart" });
  const resumen = el("div", { class: "cart__summary" });
  const btnRegistrar = el("button", { class: "btn btn--primary btn--lg", type: "button", text: "Registrar movimiento" });

  root.appendChild(
    el("section", { class: "card card--pad" }, [
      el("div", { class: "section-head" }, [
        el("h3", { class: "section-title", text: "Productos" }),
        el("button", {
          class: "btn btn--primary", type: "button", text: "+ Agregar producto",
          onclick: () => abrirBusqueda(),
        }),
      ]),
      cuerpoCarrito,
      resumen,
      el("div", { class: "cart__actions" }, [btnRegistrar]),
    ])
  );

  btnRegistrar.addEventListener("click", registrar);
  pintarCarrito();

  // ---- Lógica del carrito
  function abrirBusqueda() {
    // En una salida hay que descontar de una existencia concreta, así que el
    // buscador lista existencias en vez de productos del catálogo.
    const esSalida = !chkInicial.checked && inputs.tipo_movimiento.value === "salida";
    openProductSearch({
      almacenId,
      almacenNombre: almacen.nombre,
      modo: esSalida ? "salida" : "entrada",
      estados,
      onPick: agregar,
    });
  }

  // Dos renglones son el mismo solo si coinciden producto + estado + ubicación:
  // ese es el grano del stock, y es lo que decide si suma o crea existencia nueva.
  const mismaClave = (a, b) =>
    a.producto.id === b.producto.id &&
    (a.estado_id ?? null) === (b.estado_id ?? null) &&
    normUbic(a.ubicacion) === normUbic(b.ubicacion);

  function agregar(item) {
    const existente = carrito.find((l) => mismaClave(l, item));
    if (existente) {
      // Un activo fijo es una unidad física única: no se acumula ni se duplica.
      if (item.producto.es_trazable) {
        toast(`“${item.producto.nombre}” es un activo fijo y ya está en el ticket.`, "error");
        return;
      }
      existente.cantidad += item.cantidad;
    } else if (item.producto.es_trazable && carrito.some((l) => l.producto.id === item.producto.id)) {
      toast(`“${item.producto.nombre}” es un activo fijo y ya está en el ticket.`, "error");
      return;
    } else {
      carrito.push({ ...item });
    }
    pintarCarrito();
  }

  function quitar(index) {
    carrito.splice(index, 1);
    pintarCarrito();
  }

  function pintarCarrito() {
    clear(cuerpoCarrito);
    clear(resumen);

    if (!carrito.length) {
      cuerpoCarrito.appendChild(
        el("div", { class: "empty-state" }, [
          el("p", { text: "El ticket todavía no tiene productos." }),
          el("p", { class: "form-hint", text: "Usa “Agregar producto” para buscarlos por número de parte, nombre o serie." }),
        ])
      );
      btnRegistrar.disabled = true;
      return;
    }
    btnRegistrar.disabled = false;

    const esInicial = chkInicial.checked;
    const esSalida = !esInicial && inputs.tipo_movimiento.value === "salida";
    const tabla = el("table", { class: "table table--cart" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "Producto" }),
          el("th", { text: "No.Parte" }),
          el("th", { text: "Serie" }),
          el("th", { text: "Estado" }),
          el("th", { text: "Ubicación" }),
          el("th", { class: "num", text: "Cantidad" }),
          el("th", { class: "col-actions", text: "Acciones" }),
        ]),
      ]),
    ]);

    const tbody = el("tbody");
    carrito.forEach((linea, i) => {
      const cant = el("input", {
        class: "input input--qty", type: "number", min: "0.01", step: "any",
        value: String(linea.cantidad),
        "aria-label": `Cantidad de ${linea.producto.nombre}`,
        onchange: (e) => {
          const n = Number(e.target.value);
          if (n > 0) { linea.cantidad = n; pintarCarrito(); }
          else { e.target.value = String(linea.cantidad); }
        },
      });

      // En una salida el renglón ya apunta a una existencia concreta:
      // cambiar su estado o ubicación aquí la convertiría en otra existencia.
      const bloqueado = esSalida && linea.producto_almacen_id != null;

      const celdaEstado = bloqueado
        ? el("span", { text: nombreEstado(estados, linea.estado_id) })
        : el("select", {
            class: "input input--mini", "aria-label": `Estado de ${linea.producto.nombre}`,
            onchange: (e) => {
              linea.estado_id = e.target.value ? Number(e.target.value) : null;
              pintarCarrito();
            },
          }, [
            el("option", { value: "", text: "Sin estado" }),
            ...estados.map((s) => {
              const o = el("option", { value: String(s.id), text: s.nombre });
              if (String(s.id) === String(linea.estado_id ?? "")) o.selected = true;
              return o;
            }),
          ]);

      const celdaUbic = bloqueado
        ? el("span", { class: "mono", text: linea.ubicacion || "—" })
        : el("input", {
            class: "input input--mini", type: "text", value: linea.ubicacion || "",
            placeholder: "Ubicación…", autocomplete: "off",
            "aria-label": `Ubicación de ${linea.producto.nombre}`,
            onchange: (e) => {
              linea.ubicacion = e.target.value.trim() || null;
              pintarCarrito();
            },
          });

      tbody.appendChild(
        el("tr", {}, [
          el("td", {}, [
            el("div", { class: "cart__name", text: linea.producto.nombre }),
            el("div", { class: "cart__sub" }, [
              linea.producto.no_parte ? el("span", { class: "mono", text: linea.producto.codigo_barras }) : null,
              linea.producto.es_trazable ? el("span", { class: "badge badge--fijo", text: "Trazable" }) : null,
            ]),
          ]),
          el("td", { class: "mono", text: linea.producto.no_parte || "—" }),
          el("td", { class: "mono", text: linea.producto.no_serie || "—" }),
          el("td", {}, [celdaEstado]),
          el("td", {}, [celdaUbic]),
          el("td", { class: "num" }, [cant]),
          el("td", { class: "col-actions" }, [
            iconButton("Quitar", "btn--danger-ghost", () => quitar(i)),
          ]),
        ])
      );
    });
    tabla.appendChild(tbody);
    cuerpoCarrito.appendChild(el("div", { class: "table-wrap" }, [tabla]));

    const totalCant = carrito.reduce((s, l) => s + l.cantidad, 0);
    resumen.appendChild(
      el("dl", { class: "totals" }, [
        el("div", {}, [el("dt", { text: "Total de items" }), el("dd", { class: "mono", text: String(carrito.length) })]),
        el("div", {}, [el("dt", { text: "Cantidad total" }), el("dd", { class: "mono", text: String(totalCant) })]),
      ])
    );

    if (esInicial) {
      resumen.appendChild(
        el("p", { class: "notice notice--warn", role: "status" },
          "Stock Inicial: cada renglón dejará esa existencia (producto + estado + ubicación) exactamente en la cantidad capturada. Las demás existencias del mismo producto no cambian.")
      );
    }

    // Renglones del mismo producto con distinto estado/ubicación: es válido,
    // pero conviene avisarlo porque generará existencias separadas.
    const separados = carrito
      .filter((l, i) => carrito.some((o, j) => j !== i && o.producto.id === l.producto.id))
      .map((l) => l.producto.nombre);
    if (separados.length) {
      resumen.appendChild(
        el("p", { class: "notice", role: "status" },
          `Hay renglones del mismo producto con distinto estado o ubicación (${[...new Set(separados)].join(", ")}). Se registrarán como existencias separadas.`)
      );
    }
  }

  async function registrar() {
    if (!carrito.length) return;
    btnRegistrar.disabled = true;
    btnRegistrar.textContent = "Registrando…";
    try {
      const usuario = getCurrentUsuario();
      const leer = (nombre) => readField(campos.find((c) => c.name === nombre), inputs[nombre]);
      const { data, error } = await supabase.rpc("registrar_movimiento", {
        p_almacen_id: almacenId,
        p_fecha: leer("fecha") || hoy(),
        p_tipo_movimiento: chkInicial.checked ? "entrada" : inputs.tipo_movimiento.value,
        p_es_stock_inicial: chkInicial.checked,
        p_motivo: leer("motivo"),
        p_observaciones: leer("observaciones"),
        p_usuario_id: usuario ? usuario.id : null,
        p_items: carrito.map((l) => ({
          producto_id: l.producto.id,
          cantidad: l.cantidad,
          estado_id: l.estado_id ?? null,
          ubicacion: l.ubicacion ?? null,
          // Presente en salidas: identifica la existencia exacta a descontar.
          producto_almacen_id: l.producto_almacen_id ?? null,
        })),
        p_id_producto_unidad: referencias.id_producto_unidad,
        p_id_equipo: referencias.id_equipo,
        p_id_unidad_operativa: referencias.id_unidad_operativa,
        p_id_proveedor: referencias.id_proveedor,
      });
      if (error) throw error;

      toast(`Movimiento ${data.folio} registrado.`, "success");
      carrito.length = 0;
      pintarCarrito();
      verTicket({ ...data, almacen_nombre: almacen.nombre });
    } catch (err) {
      toast(err.message || "No se pudo registrar el movimiento.", "error");
    } finally {
      btnRegistrar.disabled = false;
      btnRegistrar.textContent = "Registrar movimiento";
    }
  }
}

// =====================================================================
// Ticket (modal de detalle)
// =====================================================================
async function verTicket(mov) {
  const body = el("div", { class: "modal__body" }, [el("p", { class: "loading", text: "Cargando ticket…" })]);
  openModal({
    title: "Ticket de movimiento",
    body,
    submitLabel: "Cerrar",
    readOnly: true,
    size: "wide",
    actions: [{ label: "Imprimir", onClick: () => imprimirZona() }],
    onSubmit: async (close) => close(),
  });

  // Siempre se relee de la vista: al venir recién registrado, `mov` es la fila
  // cruda de la RPC y trae solo los ids, sin los nombres de unidad y equipo.
  const [{ data: cab }, { data, error }] = await Promise.all([
    supabase.from("vw_movimientos").select("*").eq("id", mov.id).maybeSingle(),
    supabase.from("vw_movimiento_detalle").select("*").eq("movimiento_id", mov.id).order("id"),
  ]);
  const t = { ...mov, ...(cab || {}) };

  // El activo referenciado: nombre del producto + su identificación física.
  const activo = [t.unidad_producto_nombre, t.unidad_descripcion].filter(Boolean).join(" · ");
  const equipo = [t.equipo_etiqueta, t.equipo_marca].filter(Boolean).join(" · ");
  const proveedor = [t.proveedor_codigo, t.proveedor_razon_social].filter(Boolean).join(" · ");
  const unidadOp = [t.unidad_operativa_codigo, t.unidad_operativa_nombre].filter(Boolean).join(" · ");
  const ubicacionOp = [t.unidad_operativa_proyecto, t.unidad_operativa_ubicacion, t.unidad_operativa_zona]
    .filter(Boolean).join(" · ");

  // Nada vacío llega al papel: cada dato aparece solo si tiene valor.
  const datos = [
    ["Fecha", t.fecha ? formatFecha(t.fecha) : null],
    ["Almacén", t.almacen_nombre],
    ["Tipo", t.es_stock_inicial ? "Stock Inicial" : (t.tipo_movimiento === "salida" ? "Salida" : "Entrada")],
    ["Motivo", t.motivo],
    ["Proveedor", proveedor],
    ["Producto / activo", activo],
    ["Equipo", equipo],
    ["Unidad operativa", unidadOp],
    ["Proyecto / zona", ubicacionOp],
    ["Registró", t.usuario_nombre],
  ].filter(([, v]) => v != null && String(v).trim() !== "");

  // Todo lo que va al papel vive dentro de este contenedor.
  const hoja = el("div", { class: "ticket zona-impresion" }, [
    el("div", { class: "ticket__head" }, [
      el("img", { class: "ticket__logo", src: LOGO_EMPRESA, alt: "Corimayo" }),
      el("p", { class: "ticket__label", text: "Folio" }),
      el("p", { class: "ticket__folio mono", text: t.folio }),
      // Dos versiones: la de pantalla sigue el tema; la de papel va en negro,
      // porque en tema oscuro el código saldría blanco sobre blanco.
      renderBarcodeLabel(t.folio, { height: 44 }),
      el("div", { class: "solo-impresion" }, [
        renderBarcodeLabel(t.folio, { height: 44, lineColor: "#111111" }),
      ]),
    ]),
    el("dl", { class: "ticket__meta" }, datos.map(([k, v]) => metaItem(k, v))),
    // Texto libre: va aparte porque puede ser largo y no cabe en la rejilla.
    t.observaciones && String(t.observaciones).trim()
      ? el("div", { class: "ticket__obs" }, [
          el("p", { class: "ticket__label", text: "Observaciones" }),
          el("p", { class: "ticket__obs-texto", text: t.observaciones }),
        ])
      : null,
    t.equipo_descripcion && String(t.equipo_descripcion).trim()
      ? el("div", { class: "ticket__obs" }, [
          el("p", { class: "ticket__label", text: "Descripción del equipo" }),
          el("p", { class: "ticket__obs-texto", text: t.equipo_descripcion }),
        ])
      : null,
  ]);

  clear(body);
  body.appendChild(hoja);

  if (error) {
    body.appendChild(el("div", { class: "alert alert--error", text: `No se pudo cargar el detalle: ${error.message}` }));
    return;
  }

  const columnas = [
    { key: "producto_nombre", label: "Producto" },
    { key: "no_parte", label: "No. parte" },
    { key: "no_serie", label: "Serie" },
    { key: "estado_nombre", label: "Estado" },
    { key: "ubicacion", label: "Ubicación", render: (r) => el("span", { class: "mono", text: r.ubicacion || "—" }) },
    { key: "cantidad", label: "Cantidad", render: (r) => numCell(r.cantidad) },
  ];
  // La tabla entra en la hoja: sin ella el ticket impreso no dice qué se movió.
  hoja.appendChild(buildTable(columnas, data || [], null));
  hoja.appendChild(
    el("p", { class: "ticket__pie", text: `${(data || []).length} renglón(es) · impreso desde Gestión de Almacén` })
  );
}

function metaItem(label, value) {
  return el("div", {}, [el("dt", { text: label }), el("dd", { text: value ?? "—" })]);
}

// =====================================================================
// Referencias del ticket (unidad / equipo)
// =====================================================================
// Botón que abre el selector con filtro y muestra lo elegido como chip.
function buildReferencia({ etiqueta, icono, textoBoton, config, onElegir, describir }) {
  const valor = el("div", { class: "ref__valor" });
  const boton = el("button", { class: "btn btn--ghost", type: "button", text: `+ ${textoBoton}` });

  const nodo = el("div", { class: "ref" }, [
    el("span", { class: "ref__label" }, [
      el("span", { class: "ref__icon", "aria-hidden": "true", html: icon(icono, { size: 16, stroke: 1.8 }) }),
      el("span", { text: etiqueta }),
    ]),
    valor,
    boton,
  ]);

  function pintarVacio() {
    clear(valor);
    valor.appendChild(el("span", { class: "ref__vacio", text: "Sin asignar" }));
    boton.textContent = `+ ${textoBoton}`;
  }

  function pintarElegido(row) {
    clear(valor);
    valor.appendChild(
      el("span", { class: "chip" }, [
        el("span", { class: "chip__label", text: describir(row) || `#${row.id}` }),
        el("button", {
          type: "button", class: "chip__remove", "aria-label": `Quitar ${etiqueta.toLowerCase()}`,
          onclick: () => { onElegir(null); pintarVacio(); },
        }, "×"),
      ])
    );
    boton.textContent = "Cambiar";
  }

  boton.addEventListener("click", () => {
    openPicker({ config, onPick: (row) => { onElegir(row); pintarElegido(row); } });
  });

  pintarVacio();
  return { nodo };
}

// =====================================================================
// Utilidades
// =====================================================================
async function getAlmacen(id) {
  const { data } = await supabase.from("almacenes").select("*").eq("id", id).maybeSingle();
  return data;
}

async function loadEstados() {
  const { data } = await supabase.from("estados").select("id, nombre").eq("activo", true).order("nombre");
  return data || [];
}

function tipoBadge(row) {
  if (row.es_stock_inicial) return el("span", { class: "badge badge--inicial", text: "Stock inicial" });
  const salida = row.tipo_movimiento === "salida";
  return el("span", { class: `badge ${salida ? "badge--out" : "badge--in"}`, text: salida ? "Salida" : "Entrada" });
}

function numCell(v) {
  return el("span", { class: "mono", text: v == null ? "—" : String(v) });
}

function formatFecha(f) {
  if (!f) return "—";
  // 'YYYY-MM-DD' se interpreta como UTC; se construye local para no desfasar el día.
  const [y, m, d] = String(f).slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat(navigator.language || "es-MX", { dateStyle: "medium" })
    .format(new Date(y, m - 1, d));
}

function hoy() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Misma normalización que la columna generada `ubicacion_norm` en la base:
// así el carrito agrupa igual que lo hará el servidor.
function normUbic(v) {
  return (v || "").trim().toUpperCase();
}

function nombreEstado(estados, id) {
  if (id == null) return "Sin estado";
  return estados.find((e) => String(e.id) === String(id))?.nombre || "Sin estado";
}
