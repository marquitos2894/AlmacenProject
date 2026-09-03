// Transferencias entre almacenes — flujo de 2 pasos:
//   #/transferencias         → historial
//   #/transferencias/nueva    → capturar (origen, destino, carrito)
//
// El stock lo mueve el RPC `registrar_transferencia` en una sola transacción:
// resta en la existencia de origen y suma/fusiona en el destino. No se escribe
// en `movimientos`; el seguimiento vive en este historial propio.
import { supabase } from "../supabaseClient.js";
import { getCurrentUsuario, puedeEditar } from "../auth.js";
import { openProductSearch } from "../productSearch.js";
import { mensajeError } from "../crud.js";
import { badgeAlmacen, badgeEstado } from "../badges.js";
import { botonEscanear } from "../scanner.js";
import { el, clear, toast, openModal, buildField, readField, buildTable, iconButton, imprimirZona } from "../ui.js";

const LOGO_EMPRESA = "img/logo/corimayologo.png";

// Sobrevive a los re-render de la vista (mismo criterio que Stock por almacén).
const filtros = { almacen_id: "", q: "" };

export default {
  async render(root, params = []) {
    if (params[0] === "nueva") return renderForm(root);
    return renderHistorial(root);
  },
};

// =====================================================================
// Historial
// =====================================================================
async function renderHistorial(root) {
  clear(root);
  root.appendChild(
    el("div", { class: "page-header" }, [
      el("div", {}, [
        el("h2", { class: "page-title", text: "Transferencias" }),
        el("p", { class: "page-subtitle", text: "Movimientos de stock entre almacenes." }),
      ]),
      puedeEditar()
        ? el("a", { class: "btn btn--primary", href: "#/transferencias/nueva", text: "+ Nueva transferencia" })
        : null,
    ])
  );

  const almacenes = await cargarAlmacenes();
  const lista = el("div", { class: "card" });
  root.appendChild(buildFiltros(almacenes, () => cargar(lista)));
  root.appendChild(lista);
  await cargar(lista);
}

function buildFiltros(almacenes, onChange) {
  const almacen = el("select", {
    class: "input", id: "f-almacen",
    onchange: (e) => { filtros.almacen_id = e.target.value; onChange(); },
  }, [
    el("option", { value: "", text: "Todos los almacenes" }),
    ...almacenes.map((a) => {
      const o = el("option", { value: String(a.id), text: a.nombre });
      if (String(a.id) === String(filtros.almacen_id)) o.selected = true;
      return o;
    }),
  ]);
  const busca = el("input", {
    class: "input", type: "search", id: "f-busca", value: filtros.q,
    placeholder: "No. de parte, nombre, serie, código…", autocomplete: "off", spellcheck: "false",
    oninput: debounce((e) => { filtros.q = e.target.value; onChange(); }),
  });
  const scan = botonEscanear((codigo) => {
    busca.value = codigo;
    filtros.q = codigo;
    onChange();
  }, { texto: true, bloque: true });

  return el("div", { class: "filters" }, [
    el("div", { class: "filter filter--primary" }, [
      el("label", { class: "filter-label", for: "f-almacen", text: "Almacén (origen o destino)" }), almacen,
    ]),
    el("div", { class: "filter" }, [
      el("label", { class: "filter-label", for: "f-busca", text: "Producto" }), busca,
    ]),
    scan ? el("div", { class: "filter" }, [el("span", { class: "filter-label", text: "Código de barras" }), scan]) : null,
  ]);
}

async function cargar(container) {
  clear(container);
  container.appendChild(el("p", { class: "loading", text: "Cargando…" }));

  // Un renglón por línea de producto, no agrupado por transferencia.
  let q = supabase.from("vw_transferencia_detalle").select("*");
  if (filtros.almacen_id) {
    const id = Number(filtros.almacen_id);
    q = q.or(`almacen_origen_id.eq.${id},almacen_destino_id.eq.${id}`);
  }
  if (filtros.q) {
    const safe = filtros.q.replace(/[,()*]/g, " ").trim();
    // No. de parte, nombre, código de barras y —solo componentes— serie y
    // código interno (NULL en consumibles, así que no estorban).
    if (safe) q = q.or(`no_parte.ilike.%${safe}%,producto_nombre.ilike.%${safe}%,codigo_barras.ilike.%${safe}%,no_serie.ilike.%${safe}%,codigo_interno.ilike.%${safe}%`);
  }
  q = q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(300);

  const { data, error } = await q;
  clear(container);
  if (error) {
    container.appendChild(el("div", { class: "alert alert--error", text: `No se pudieron cargar las transferencias: ${error.message}` }));
    return;
  }

  const columnas = [
    { key: "folio", label: "Folio", render: (r) => el("span", { class: "folio-tag mono", text: r.folio }) },
    { key: "fecha", label: "Fecha", render: (r) => formatFecha(r.fecha) },
    { key: "almacen_origen_nombre", label: "Origen", render: (r) => badgeAlmacen(r.almacen_origen_nombre) },
    { key: "almacen_destino_nombre", label: "Destino", render: (r) => badgeAlmacen(r.almacen_destino_nombre) },
    { key: "producto_nombre", label: "Producto", render: celdaProducto },
    { key: "no_parte", label: "No. parte", render: (r) => el("span", { class: "mono", text: r.no_parte || "—" }) },
    { key: "cantidad", label: "Cantidad", render: (r) => numCell(r.cantidad) },
    { key: "motivo", label: "Motivo" },
  ];

  container.appendChild(
    buildTable(columnas, data || [], (row) => [
      iconButton("Ver ticket", "btn--ghost", () => verTicket({ id: row.transferencia_id, folio: row.folio }), "ticket"),
    ])
  );
  container.appendChild(el("p", { class: "list-meta", text: `${(data || []).length} línea(s) de transferencia.` }));
}

// Celda "Producto": nombre y, solo para componentes, su serie o código interno.
function celdaProducto(r) {
  const sub = r.es_trazable ? (r.no_serie || r.codigo_interno) : null;
  return el("div", { class: "cell-stack" }, [
    el("div", { text: r.producto_nombre || "—" }),
    sub ? el("div", { class: "cell-sub mono", text: sub }) : null,
  ]);
}

// =====================================================================
// Formulario
// =====================================================================
async function renderForm(root) {
  clear(root);

  if (!puedeEditar()) {
    root.appendChild(cabecera("Nueva transferencia"));
    root.appendChild(el("div", { class: "alert alert--error", text: "Tu cuenta es de solo lectura: no puedes registrar transferencias." }));
    return;
  }

  const [almacenes, estados] = await Promise.all([cargarAlmacenes(), cargarEstados()]);
  if (almacenes.length < 2) {
    root.appendChild(cabecera("Nueva transferencia"));
    root.appendChild(el("div", { class: "alert alert--error", text: "Necesitas al menos dos almacenes activos para transferir." }));
    return;
  }

  const carrito = [];
  const nombreAlmacen = (id) => almacenes.find((a) => String(a.id) === String(id))?.nombre || "";

  root.appendChild(cabecera("Nueva transferencia", "Elige el almacén de origen y el de destino, y añade los productos a mover."));

  // ---- Datos de la transferencia
  const campos = [
    { name: "fecha", label: "Fecha", type: "date", required: true },
    { name: "motivo", label: "Motivo", type: "text", placeholder: "Traspaso, reubicación, ajuste…" },
    { name: "observaciones", label: "Observaciones", type: "textarea" },
  ];
  const grid = el("div", { class: "form-grid" });
  const inputs = {};
  for (const f of campos) {
    const { wrap, input } = buildField(f, f.name === "fecha" ? hoy() : "");
    if (f.name === "observaciones") wrap.classList.add("form-grid__full");
    grid.appendChild(wrap);
    inputs[f.name] = input;
  }

  const selOrigen = selectAlmacen("t-origen", "— Elige origen —", almacenes);
  const selDestino = selectAlmacen("t-destino", "— Elige destino —", almacenes);
  const aviso = el("p", { class: "notice", role: "status" });
  aviso.hidden = true;

  const parAlmacenes = el("div", { class: "form-grid" }, [
    el("div", { class: "form-row" }, [
      el("label", { class: "form-label", for: "t-origen", text: "Almacén de origen *" }), selOrigen,
    ]),
    el("div", { class: "form-row" }, [
      el("label", { class: "form-label", for: "t-destino", text: "Almacén de destino *" }), selDestino,
    ]),
  ]);

  const btnAgregar = el("button", {
    class: "btn btn--primary", type: "button", text: "+ Agregar producto",
    onclick: () => abrirBusqueda(),
  });
  btnAgregar.disabled = true;

  const cuerpo = el("div", { class: "cart" });
  const resumen = el("div", { class: "cart__summary" });
  const btnRegistrar = el("button", { class: "btn btn--primary btn--lg", type: "button", text: "Registrar transferencia" });
  btnRegistrar.addEventListener("click", registrar);

  root.appendChild(
    el("section", { class: "card card--pad" }, [
      el("h3", { class: "section-title", text: "Datos de la transferencia" }),
      parAlmacenes,
      aviso,
      grid,
    ])
  );
  root.appendChild(
    el("section", { class: "card card--pad" }, [
      el("div", { class: "section-head" }, [
        el("h3", { class: "section-title", text: "Productos" }),
        btnAgregar,
      ]),
      cuerpo,
      resumen,
      el("div", { class: "cart__actions" }, [btnRegistrar]),
    ])
  );

  selOrigen.addEventListener("change", () => {
    // Cada renglón apunta a una existencia concreta del origen: si cambia, no valen.
    if (carrito.length) {
      carrito.length = 0;
      toast("Se vació la lista porque cambió el almacén de origen.", "info");
      pintarCarrito();
    }
    sincronizar();
  });
  selDestino.addEventListener("change", sincronizar);

  sincronizar();
  pintarCarrito();

  function sincronizar() {
    const o = selOrigen.value, d = selDestino.value;
    const iguales = o && d && o === d;
    aviso.hidden = !iguales;
    if (iguales) aviso.textContent = "El origen y el destino deben ser almacenes distintos.";
    btnAgregar.disabled = !o;
    actualizarRegistrar();
  }

  function actualizarRegistrar() {
    const o = selOrigen.value, d = selDestino.value;
    btnRegistrar.disabled = !(carrito.length && o && d && o !== d);
  }

  function abrirBusqueda() {
    if (!selOrigen.value) { toast("Primero elige el almacén de origen.", "error"); return; }
    openProductSearch({
      almacenId: Number(selOrigen.value),
      almacenNombre: nombreAlmacen(selOrigen.value),
      modo: "salida", // lista existencias reales del origen y devuelve producto_almacen_id
      estados,
      onPick: agregar,
    });
  }

  function agregar(item) {
    const existente = carrito.find((l) => l.producto_almacen_id === item.producto_almacen_id);
    if (existente) {
      if (item.producto.es_trazable) {
        toast(`“${item.producto.nombre}” ya está en la lista.`, "error");
        return;
      }
      existente.cantidad += item.cantidad;
    } else {
      carrito.push({ ...item, ubicacion_destino: "" });
    }
    pintarCarrito();
  }

  function pintarCarrito() {
    clear(cuerpo);
    clear(resumen);

    if (!carrito.length) {
      cuerpo.appendChild(
        el("div", { class: "empty-state" }, [
          el("p", { text: "La transferencia todavía no tiene productos." }),
          el("p", { class: "form-hint", text: "Usa “Agregar producto” para elegir existencias del almacén de origen." }),
        ])
      );
      actualizarRegistrar();
      return;
    }

    const tabla = el("table", { class: "table table--cart" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "Producto" }),
          el("th", { text: "No. parte" }),
          el("th", { text: "Serie" }),
          el("th", { text: "Cód. control" }),
          el("th", { text: "Estado" }),
          el("th", { text: "Ubic. origen" }),
          el("th", { text: "Ubic. destino" }),
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
          if (n > 0) linea.cantidad = n;
          else e.target.value = String(linea.cantidad);
        },
      });

      const ubicDest = el("input", {
        class: "input input--mini", type: "text", value: linea.ubicacion_destino || "",
        placeholder: linea.ubicacion || "Igual que origen", autocomplete: "off",
        "aria-label": `Ubicación destino de ${linea.producto.nombre}`,
        onchange: (e) => { linea.ubicacion_destino = e.target.value.trim(); },
      });

      tbody.appendChild(
        el("tr", {}, [
          el("td", {}, [
            el("div", { class: "cart__name", text: linea.producto.nombre }),
            el("div", { class: "cart__sub" }, [
              linea.producto.no_parte
                ? el("span", { class: "mono", text: linea.producto.codigo_barras || linea.producto.no_parte })
                : null,
              linea.producto.es_trazable ? el("span", { class: "badge badge--fijo", text: "Componente" }) : null,
            ]),
          ]),
          el("td", { class: "mono", text: linea.producto.no_parte || "—" }),
          el("td", { class: "mono", text: linea.producto.no_serie || "—" }),
          el("td", { class: "mono", text: linea.codigo_control || "—" }),
          el("td", {}, [badgeEstado(nombreEstado(estados, linea.estado_id))]),
          el("td", {}, [el("span", { class: "mono", text: linea.ubicacion || "—" })]),
          el("td", {}, [ubicDest]),
          el("td", { class: "num" }, [cant]),
          el("td", { class: "col-actions" }, [
            iconButton("Quitar", "btn--danger-ghost", () => { carrito.splice(i, 1); pintarCarrito(); }),
          ]),
        ])
      );
    });
    tabla.appendChild(tbody);
    cuerpo.appendChild(el("div", { class: "table-wrap" }, [tabla]));

    const totalCant = carrito.reduce((s, l) => s + l.cantidad, 0);
    resumen.appendChild(
      el("dl", { class: "totals" }, [
        el("div", {}, [el("dt", { text: "Total de items" }), el("dd", { class: "mono", text: String(carrito.length) })]),
        el("div", {}, [el("dt", { text: "Cantidad total" }), el("dd", { class: "mono", text: String(totalCant) })]),
      ])
    );

    const traz = carrito.filter((l) => l.producto.es_trazable).map((l) => l.producto.nombre);
    if (traz.length) {
      resumen.appendChild(
        el("p", { class: "notice", role: "status" },
          `Componentes (${[...new Set(traz)].join(", ")}): se transfieren completos y su existencia cambia de almacén.`)
      );
    }

    actualizarRegistrar();
  }

  async function registrar() {
    if (!carrito.length) return;
    const o = Number(selOrigen.value);
    const d = Number(selDestino.value);
    if (!o || !d || o === d) {
      toast("Elige un almacén de origen y uno de destino distintos.", "error");
      return;
    }

    btnRegistrar.disabled = true;
    btnRegistrar.textContent = "Registrando…";
    try {
      const usuario = getCurrentUsuario();
      const leer = (nombre) => readField(campos.find((c) => c.name === nombre), inputs[nombre]);
      const { data, error } = await supabase.rpc("registrar_transferencia", {
        p_almacen_origen_id: o,
        p_almacen_destino_id: d,
        p_fecha: leer("fecha") || hoy(),
        p_motivo: leer("motivo"),
        p_observaciones: leer("observaciones"),
        p_usuario_id: usuario ? usuario.id : null,
        p_items: carrito.map((l) => ({
          producto_almacen_id_origen: l.producto_almacen_id,
          producto_id: l.producto.id,
          cantidad: l.cantidad,
          ubicacion_destino: l.ubicacion_destino || null,
        })),
      });
      if (error) throw error;

      toast(`Transferencia ${data.folio} registrada.`, "success");
      carrito.length = 0;
      pintarCarrito();
      verTicket({ ...data, almacen_origen_nombre: nombreAlmacen(o), almacen_destino_nombre: nombreAlmacen(d) });
    } catch (err) {
      toast(mensajeError(err) || "No se pudo registrar la transferencia.", "error");
    } finally {
      btnRegistrar.textContent = "Registrar transferencia";
      actualizarRegistrar();
    }
  }
}

// =====================================================================
// Ticket (modal de detalle)
// =====================================================================
async function verTicket(base) {
  const body = el("div", { class: "modal__body" }, [el("p", { class: "loading", text: "Cargando ticket…" })]);
  openModal({
    title: "Ticket de transferencia",
    body,
    submitLabel: "Cerrar",
    readOnly: true,
    size: "wide",
    actions: [{ label: "Imprimir", onClick: () => imprimirZona() }],
    onSubmit: async (close) => close(),
  });

  // Se relee siempre: al venir recién registrada, `base` es la fila cruda del RPC.
  const [{ data: cab }, { data, error }] = await Promise.all([
    supabase.from("vw_transferencias").select("*").eq("id", base.id).maybeSingle(),
    supabase.from("vw_transferencia_detalle").select("*").eq("transferencia_id", base.id).order("id"),
  ]);
  const t = { ...base, ...(cab || {}) };

  const datos = [
    ["Fecha", t.fecha ? formatFecha(t.fecha) : null],
    ["Origen", t.almacen_origen_nombre],
    ["Destino", t.almacen_destino_nombre],
    ["Motivo", t.motivo],
    ["Registró", t.usuario_nombre],
  ].filter(([, v]) => v != null && String(v).trim() !== "");

  const hoja = el("div", { class: "ticket zona-impresion" }, [
    el("div", { class: "ticket__head" }, [
      el("img", { class: "ticket__logo", src: LOGO_EMPRESA, alt: "Corimayo" }),
      el("p", { class: "ticket__label", text: "Folio" }),
      el("p", { class: "ticket__folio mono", text: t.folio }),
    ]),
    el("dl", { class: "ticket__meta" }, datos.map(([k, v]) =>
      el("div", {}, [el("dt", { text: k }), el("dd", { text: v ?? "—" })])
    )),
    t.observaciones && String(t.observaciones).trim()
      ? el("div", { class: "ticket__obs" }, [
          el("p", { class: "ticket__label", text: "Observaciones" }),
          el("p", { class: "ticket__obs-texto", text: t.observaciones }),
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
    // Solo aplica a componentes: su serie o, si no la tiene, su código interno.
    { key: "no_serie", label: "Serie / cód.", render: (r) => el("span", { class: "mono", text: (r.no_serie || r.codigo_interno) || "—" }) },
    { key: "estado_nombre", label: "Estado", render: (r) => badgeEstado(r.estado_nombre) },
    { key: "ubicacion_origen", label: "Ubic. origen", render: (r) => el("span", { class: "mono", text: r.ubicacion_origen || "—" }) },
    { key: "ubicacion_destino", label: "Ubic. destino", render: (r) => el("span", { class: "mono", text: r.ubicacion_destino || "—" }) },
    { key: "cantidad", label: "Cantidad", render: (r) => numCell(r.cantidad) },
  ];
  hoja.appendChild(buildTable(columnas, data || [], null));
  hoja.appendChild(
    el("p", { class: "ticket__pie", text: `${(data || []).length} Items en Total · impreso desde Gestión de Almacén` })
  );
}

// =====================================================================
// Utilidades
// =====================================================================
function cabecera(titulo, subtitulo) {
  return el("div", { class: "page-header" }, [
    el("div", {}, [
      el("a", { class: "backlink", href: "#/transferencias", text: "← Volver a transferencias" }),
      el("h2", { class: "page-title", text: titulo }),
      subtitulo ? el("p", { class: "page-subtitle", text: subtitulo }) : null,
    ]),
  ]);
}

async function cargarAlmacenes() {
  const { data } = await supabase.from("almacenes").select("id, nombre").eq("activo", true).order("nombre");
  return data || [];
}

async function cargarEstados() {
  const { data } = await supabase.from("estados").select("id, nombre").eq("activo", true).order("nombre");
  return data || [];
}

function selectAlmacen(id, placeholder, almacenes) {
  return el("select", { class: "input", id }, [
    el("option", { value: "", text: placeholder }),
    ...almacenes.map((a) => el("option", { value: String(a.id), text: a.nombre })),
  ]);
}

function nombreEstado(estados, id) {
  if (id == null) return "";
  return estados.find((e) => String(e.id) === String(id))?.nombre || "";
}

function numCell(v) {
  return el("span", { class: "mono", text: v == null ? "—" : String(v) });
}

function formatFecha(f) {
  if (!f) return "—";
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
