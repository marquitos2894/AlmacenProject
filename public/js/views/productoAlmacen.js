// Stock por almacén — SOLO CONSULTA.
// Vista agrupada por no_parte (la suma la hace SQL) y modal con el desglose
// de series. El stock se modifica únicamente desde Movimientos.
import { supabase } from "../supabaseClient.js";
import { puedeEditar } from "../auth.js";
import { mensajeError } from "../crud.js";
import { el, clear, toast, openModal, buildField, readField, buildTable, iconButton } from "../ui.js";
import { badgeEstado, badgeAlmacen, badgeStock } from "../badges.js";
import { botonEscanear } from "../scanner.js";

// Solo consumibles: los componentes (trazables) viven en Productos → Componentes,
// donde se ve su ubicación y se edita su estado.
const filtros = { almacen_id: "", no_parte: "", nombre: "", estado_id: "", codigo_barras: "" };

export default {
  async render(root) {
    clear(root);
    root.appendChild(
      el("div", { class: "page-header" }, [
        el("div", {}, [
          el("h2", { class: "page-title", text: "Stock por almacén" }),
          el("p", { class: "page-subtitle", text: "Consumibles en existencia, agrupados por número de parte." }),
        ]),
        puedeEditar()
          ? el("a", { class: "btn btn--ghost", href: "#/movimientos", text: "Registrar un movimiento" })
          : null,
      ])
    );

    const [almacenes, estados] = await Promise.all([
      cargarCatalogo("almacenes"),
      cargarCatalogo("estados"),
    ]);

    const lista = el("div", { class: "card" });
    root.appendChild(buildFiltros({ almacenes, estados }, () => cargar(lista)));
    root.appendChild(lista);
    await cargar(lista);
  },
};

function buildFiltros({ almacenes, estados }, onChange) {
  const almacen = selectFiltro("f-almacen", "Todos los almacenes", almacenes, filtros.almacen_id, (v) => {
    filtros.almacen_id = v; onChange();
  });
  const estado = selectFiltro("f-estado", "Todos los estados", estados, filtros.estado_id, (v) => {
    filtros.estado_id = v; onChange();
  });
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

  // Código de barras: no hay input tecleable; se fija escaneando y se muestra
  // como chip con "✕" para limpiarlo. Con código activo, `cargar()` consulta el
  // detalle (vw_producto_almacen sí expone codigo_barras).
  const celdaCodigo = el("div", {});
  function pintarCeldaCodigo() {
    clear(celdaCodigo);
    if (filtros.codigo_barras) {
      celdaCodigo.appendChild(
        el("span", { class: "chip" }, [
          el("span", { class: "chip__label mono", text: filtros.codigo_barras }),
          el("button", {
            type: "button", class: "chip__remove", "aria-label": "Quitar código de barras",
            onclick: () => { filtros.codigo_barras = ""; pintarCeldaCodigo(); onChange(); },
          }, "×"),
        ])
      );
    } else {
      const b = botonEscanear((codigo) => { filtros.codigo_barras = codigo.trim(); pintarCeldaCodigo(); onChange(); }, { texto: true, bloque: true });
      celdaCodigo.appendChild(b || el("span", { class: "form-hint", text: "Escaneo no disponible en este navegador." }));
    }
  }
  pintarCeldaCodigo();

  return el("div", { class: "filters" }, [
    el("div", { class: "filter filter--primary" }, [
      el("label", { class: "filter-label", for: "f-almacen", text: "Almacén" }), almacen,
    ]),
    el("div", { class: "filter" }, [el("label", { class: "filter-label", for: "f-no-parte", text: "No. de parte" }), noParte]),
    el("div", { class: "filter" }, [el("label", { class: "filter-label", for: "f-nombre", text: "Nombre" }), nombre]),
    el("div", { class: "filter" }, [el("label", { class: "filter-label", for: "f-estado", text: "Estado" }), estado]),
    el("div", { class: "filter" }, [el("label", { class: "filter-label", text: "Código de barras" }), celdaCodigo]),
  ]);
}

// ---------------------------------------------------------------- Lista
async function cargar(container) {
  clear(container);
  container.appendChild(el("p", { class: "loading", text: "Cargando…" }));

  // Estado y nombre son datos de cada existencia: la vista agregada no los
  // expone, así que con cualquiera de ellos se consulta el detalle y se agrupa
  // en el cliente. Sin ellos se usa la agregación de SQL, que es más barata.
  const agrupaEnSql = !filtros.estado_id && !filtros.nombre && !filtros.codigo_barras;

  let filas;
  let error;
  if (agrupaEnSql) {
    let q = supabase.from("vw_stock_agrupado").select("*").eq("es_trazable", false);
    if (filtros.almacen_id) q = q.eq("almacen_id", filtros.almacen_id);
    if (filtros.no_parte) q = q.ilike("no_parte", `%${filtros.no_parte}%`);
    q = q.order("almacen_nombre").order("no_parte");
    ({ data: filas, error } = await q);
  } else {
    let q = supabase.from("vw_producto_almacen").select("*").eq("es_trazable", false);
    if (filtros.almacen_id) q = q.eq("almacen_id", filtros.almacen_id);
    if (filtros.estado_id) q = q.eq("estado_id", filtros.estado_id);
    if (filtros.no_parte) q = q.ilike("no_parte", `%${filtros.no_parte}%`);
    if (filtros.nombre) q = q.ilike("producto_nombre", `%${filtros.nombre}%`);
    if (filtros.codigo_barras) q = q.ilike("codigo_barras", `%${filtros.codigo_barras}%`);
    const res = await q;
    error = res.error;
    filas = agrupar(res.data || []);
  }

  clear(container);
  if (error) {
    container.appendChild(el("div", { class: "alert alert--error", text: `No se pudo cargar el stock: ${error.message}` }));
    return;
  }

  const columnas = [
    { key: "almacen_nombre", label: "Almacén", render: (r) => badgeAlmacen(r.almacen_nombre) },
    { key: "no_parte", label: "No. parte", render: (r) => el("span", { class: "mono", text: r.no_parte || "Sin no. de parte" }) },
    { key: "producto_nombre", label: "Producto" },
    { key: "stock_total", label: "Stock total", render: (r) => badgeStock(r.stock_total ?? 0) },
  
    {
      key: "total_existencias", label: "Ubicaciones",
      render: (r) => el("span", {
        class: "mono", title: "Renglones de stock: un producto puede estar dividido por estado y ubicación",
        text: String(r.total_existencias ?? r.total_series ?? 0),
      }),
    },
  ];

  container.appendChild(
    buildTable(columnas, filas || [], (row) => [
      iconButton("Ver detalles", "btn--ghost", () => verDetalle(row, () => cargar(container)), "search"),
    ])
  );
  container.appendChild(el("p", { class: "list-meta", text: `${(filas || []).length} grupo(s) por número de parte.` }));
}

// Agrupación en cliente (cuando hay filtros a nivel de ítem).
// Replica el criterio de vw_stock_agrupado: total_series cuenta artículos
// físicos distintos y total_existencias cuenta renglones de stock.
function agrupar(rows) {
  const mapa = new Map();
  for (const r of rows) {
    // Sin número de parte, cada producto es su propio grupo (mismo criterio que
    // vw_stock_agrupado): así no se juntan productos distintos en una fila.
    const clave = `${r.almacen_id}|${r.no_parte || `prod:${r.producto_id}`}`;
    const g = mapa.get(clave) || {
      almacen_id: r.almacen_id,
      almacen_nombre: r.almacen_nombre,
      no_parte: r.no_parte,
      producto_nombre: r.producto_nombre,
      stock_total: 0,
      total_existencias: 0,
      _productos: new Set(),
    };
    g.stock_total += Number(r.stock_actual) || 0;
    g.total_existencias += 1;
    g._productos.add(r.producto_id);
    mapa.set(clave, g);
  }
  for (const g of mapa.values()) {
    g.total_series = g._productos.size;
    delete g._productos;
  }
  return [...mapa.values()].sort(
    (a, b) => (a.almacen_nombre || "").localeCompare(b.almacen_nombre || "") ||
              (a.no_parte || "").localeCompare(b.no_parte || "")
  );
}

// ------------------------------------------------------- Modal detalle
// `onCambio` refresca la lista de fondo cuando se reclasifica una existencia.
function verDetalle(grupo, onCambio) {
  const body = el("div", { class: "modal__body" }, [el("p", { class: "loading", text: "Cargando series…" })]);
  const { close } = openModal({
    title: `Detalle — ${grupo.no_parte || "Sin no. de parte"}`,
    body,
    submitLabel: "Cerrar",
    readOnly: true,
    size: "wide",
    onSubmit: async (cerrar) => cerrar(),
  });

  cargarDetalle();

  async function cargarDetalle() {
    let q = supabase.from("vw_producto_almacen").select("*").eq("almacen_id", grupo.almacen_id);
    q = grupo.no_parte ? q.eq("no_parte", grupo.no_parte) : q.is("no_parte", null);
    // Se arrastra el filtro de estado de la lista: si no, el detalle mostraría
    // existencias que el grupo ya había descartado y los totales no cuadrarían.
    if (filtros.estado_id) q = q.eq("estado_id", filtros.estado_id);
    const { data, error } = await q.order("no_serie");

    clear(body);
    if (error) {
      body.appendChild(el("div", { class: "alert alert--error", text: `No se pudo cargar el detalle: ${error.message}` }));
      return;
    }

    const total = (data || []).reduce((s, r) => s + Number(r.stock_actual || 0), 0);
    body.appendChild(
      el("dl", { class: "ticket__meta" }, [
        el("div", {}, [el("dt", { text: "Almacén" }), el("dd", {}, [badgeAlmacen(grupo.almacen_nombre)])]),
        el("div", {}, [el("dt", { text: "Stock total" }), el("dd", { class: "mono", text: String(total) })]),
        el("div", {}, [el("dt", { text: "Ubicaciones" }), el("dd", { class: "mono", text: String((data || []).length) })]),
      ])
    );

    const columnas = [
      { key: "producto_nombre", label: "Nombre" },
      { key: "no_parte", label: "No. parte", render: (r) => el("span", { class: "mono", text: r.no_parte || "—" }) },
      { key: "no_serie", label: "Serie", render: (r) => el("span", { class: "mono", text: r.no_serie || "—" }) },
      { key: "estado_nombre", label: "Estado", render: (r) => badgeEstado(r.estado_nombre) },
      { key: "almacen_nombre", label: "Almacén", render: (r) => badgeAlmacen(r.almacen_nombre) },
      { key: "ubicacion", label: "Ubicación", render: (r) => el("span", { class: "mono", text: r.ubicacion || "—" }) },
      { key: "stock_actual", label: "Cantidad", render: (r) => el("span", { class: "mono", text: String(r.stock_actual ?? 0) }) },
      {
        key: "es_trazable", label: "Componente",
        render: (r) => (r.es_trazable ? el("span", { class: "badge badge--fijo", text: "Componente" }) : document.createTextNode("—")),
      },
    ];

    body.appendChild(
      buildTable(columnas, data || [], puedeEditar()
        ? (row) => [iconButton("Cambiar estado", "btn--ghost", () => cambiarEstado(row, data || []))]
        : null)
    );
  }

  // Reclasificar una existencia. Si el destino ya existe, el servidor fusiona
  // las dos y desactiva la de origen (salvo en activo fijo, que nunca fusiona).
  async function cambiarEstado(fila, hermanas) {
    const estados = await cargarCatalogo("estados");
    const campos = [
      { name: "estado_id", label: "Estado", type: "select", options: estados.map((e) => ({ value: e.id, label: e.nombre })) },
      { name: "ubicacion", label: "Ubicación", type: "text", placeholder: "Ubicación…" },
    ];

    const cuerpo = el("div", { class: "modal__body" }, [
      el("dl", { class: "ticket__meta" }, [
        el("div", {}, [el("dt", { text: "Producto" }), el("dd", { text: fila.producto_nombre })]),
        el("div", {}, [el("dt", { text: "Cantidad" }), el("dd", { class: "mono", text: String(fila.stock_actual ?? 0) })]),
      ]),
    ]);

    const entradas = {};
    for (const f of campos) {
      const { wrap, input } = buildField(f, fila[f.name] ?? "");
      cuerpo.appendChild(wrap);
      entradas[f.name] = input;
    }

    const aviso = el("p", { class: "notice", role: "status" });
    cuerpo.appendChild(aviso);

    // Aviso en vivo: si el destino ya existe, esto va a fusionar.
    const revisarFusion = () => {
      const est = entradas.estado_id.value ? Number(entradas.estado_id.value) : null;
      const ubi = entradas.ubicacion.value.trim().toUpperCase();
      const destino = hermanas.find(
        (h) => h.id !== fila.id &&
               (h.estado_id ?? null) === est &&
               (h.ubicacion || "").trim().toUpperCase() === ubi
      );
      if (destino && !fila.es_trazable) {
        aviso.hidden = false;
        aviso.textContent = `Ya hay ${destino.stock_actual} en ese estado y ubicación: las dos existencias se sumarán (${Number(destino.stock_actual) + Number(fila.stock_actual)}).`;
      } else {
        aviso.hidden = true;
      }
    };
    entradas.estado_id.addEventListener("change", revisarFusion);
    entradas.ubicacion.addEventListener("input", revisarFusion);
    revisarFusion();

    openModal({
      title: "Cambiar estado o ubicación",
      body: cuerpo,
      submitLabel: "Guardar",
      onSubmit: async (cerrarHijo) => {
        const { error } = await supabase.rpc("cambiar_estado_existencia", {
          p_producto_almacen_id: fila.id,
          p_estado_id: readField(campos[0], entradas.estado_id),
          p_ubicacion: readField(campos[1], entradas.ubicacion),
        });
        if (error) throw new Error(mensajeError(error));
        toast("Existencia actualizada.", "success");
        cerrarHijo();
        await cargarDetalle();
        onCambio?.();
      },
    });
  }
}

// ---------------------------------------------------------- Utilidades
async function cargarCatalogo(tabla) {
  const { data } = await supabase.from(tabla).select("id, nombre").eq("activo", true).order("nombre");
  return data || [];
}

function selectFiltro(id, placeholder, opciones, valor, onChange) {
  return el("select", { class: "input", id, onchange: (e) => onChange(e.target.value) }, [
    el("option", { value: "", text: placeholder }),
    ...opciones.map((o) => {
      const node = el("option", { value: String(o.id), text: o.nombre });
      if (String(o.id) === String(valor)) node.selected = true;
      return node;
    }),
  ]);
}

function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
