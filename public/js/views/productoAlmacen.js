// Stock por almacén — SOLO CONSULTA.
// Una fila por (almacén + n.º de parte): la suma y las cuentas las hace SQL
// (vw_stock_agrupado), paginado en el servidor. El modal "Ver detalles" abre el
// desglose por existencia. El stock se modifica únicamente desde Movimientos.
import { supabase } from "../supabaseClient.js";
import { puedeEditar } from "../auth.js";
import { mensajeError } from "../crud.js";
import { el, clear, toast, openModal, buildField, readField, buildTable, iconButton, buildPaginador } from "../ui.js";
import { badgeEstado, badgeAlmacen, badgeStock } from "../badges.js";
import { botonEscanear } from "../scanner.js";

// Solo consumibles: los componentes (trazables) viven en Productos → Componentes,
// donde se ve su ubicación y se edita su estado.
const filtros = { almacen_id: "", no_parte: "", nombre: "", estado_id: "", codigo_barras: "", codigo_control: "" };

// Filas por página. La lista se pide al servidor de página en página
// (`range` + `count`), nunca entera.
const PAGE = 50;

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
    let pagina = 0;
    // Cambiar un filtro vuelve a la primera página.
    root.appendChild(buildFiltros({ almacenes, estados }, () => { pagina = 0; cargar(); }));
    root.appendChild(lista);
    await cargar();

    async function cargar() {
      clear(lista);
      lista.appendChild(el("p", { class: "loading", text: "Cargando…" }));

      // Una sola consulta a la vista ya agregada por SQL. El grano es
      // (almacén + n.º de parte): una fila por producto, con la suma de todo su
      // stock y la cuenta de existencias/ubicaciones; el desglose por
      // ubicación/estado/código de control va en "Ver detalles". Todos los
      // filtros viajan al servidor y solo se trae la página pedida.
      let q = supabase.from("vw_stock_agrupado").select("*", { count: "exact" }).eq("es_trazable", false);
      if (filtros.almacen_id) q = q.eq("almacen_id", filtros.almacen_id);
      if (filtros.no_parte) q = q.ilike("no_parte", `%${filtros.no_parte}%`);
      // El estado ya no es del grano: la fila reúne todas las existencias del
      // producto. Filtrar por estado = "tiene alguna existencia en ese estado".
      if (filtros.estado_id) q = q.contains("estado_ids", [Number(filtros.estado_id)]);
      if (filtros.nombre) q = q.ilike("producto_nombre", `%${filtros.nombre}%`);
      if (filtros.codigo_barras) q = q.ilike("codigo_barras", `%${filtros.codigo_barras}%`);
      if (filtros.codigo_control) q = q.ilike("codigos_control", `%${filtros.codigo_control}%`);
      // Orden total y estable = el grano completo (más el nombre como desempate
      // para las filas sin no. de parte), para que la paginación no salte ni
      // repita filas entre páginas.
      q = q.order("almacen_nombre").order("no_parte").order("producto_nombre")
           .range(pagina * PAGE, pagina * PAGE + PAGE - 1);

      const { data: filas, error, count } = await q;

      clear(lista);
      if (error) {
        lista.appendChild(el("div", { class: "alert alert--error", text: `No se pudo cargar el stock: ${error.message}` }));
        return;
      }

      const total = count ?? (filas || []).length;
      const totalPaginas = Math.max(1, Math.ceil(total / PAGE));
      // Un filtro puede dejar la página actual fuera de rango: se vuelve a la última.
      if (pagina > totalPaginas - 1) { pagina = totalPaginas - 1; return cargar(); }

      const columnas = [
        { key: "almacen_nombre", label: "Almacén", render: (r) => badgeAlmacen(r.almacen_nombre) },
        { key: "no_parte", label: "No. parte", render: (r) => el("span", { class: "mono", text: r.no_parte || "Sin no. de parte" }) },
        { key: "producto_nombre", label: "Producto", render: celdaProducto },
        { key: "marca", label: "Marca", render: (r) => el("span", { text: r.marca || "—" }) },
        { key: "stock_total", label: "Stock", render: (r) => badgeStock(r.stock_total ?? 0) },
        {
          key: "total_existencias", label: "Existencias",
          render: (r) => el("span", {
            class: "mono", title: "Renglones de stock (ubicación · estado · cód. control) que suman este total; el desglose está en Ver detalles",
            text: String(r.total_existencias ?? 0),
          }),
        },
        /*{
          key: "total_ubicaciones", label: "Ubicaciones",
          render: (r) => el("span", { class: "mono", text: String(r.total_ubicaciones ?? 0) }),
        },*/
      ];

      lista.appendChild(
        buildTable(columnas, filas || [], (row) => [
          iconButton("Ver detalles", "btn--ghost", () => verDetalle(row, () => cargar()), "search"),
        ])
      );

      const desde = total ? pagina * PAGE + 1 : 0;
      const hasta = Math.min(total, (pagina + 1) * PAGE);
      lista.appendChild(
        el("div", { class: "list-foot" }, [
          el("p", { class: "list-meta", text: total ? `${desde}–${hasta} de ${total} fila(s) de stock` : "0 filas de stock" }),
          buildPaginador(pagina, totalPaginas, (p) => { pagina = p; cargar(); }),
        ])
      );
    }
  },
};

// Celda "Producto": nombre y, debajo, el/los código(s) de control de sus
// existencias en ese almacén (la fila agrupa todo el n.º de parte, así que
// puede haber más de uno si hay varios lotes).
function celdaProducto(r) {
  return el("div", { class: "cell-stack" }, [
    el("div", { text: r.producto_nombre || "—" }),
    r.codigos_control ? el("div", { class: "cell-sub mono", text: `Cód. control: ${r.codigos_control}` }) : null,
  ]);
}

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
  const codigoControl = el("input", {
    class: "input", type: "search", id: "f-codigo-control", value: filtros.codigo_control,
    placeholder: "N.º de OT, código del proveedor…", autocomplete: "off", spellcheck: "false",
    oninput: debounce((e) => { filtros.codigo_control = e.target.value; onChange(); }),
  });

  // Código de barras: no hay input tecleable; se fija escaneando y se muestra
  // como chip con "✕" para limpiarlo. Con código activo, `cargar()` filtra por
  // la columna `codigo_barras` de vw_stock_agrupado.
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
    el("div", { class: "filter" }, [el("label", { class: "filter-label", for: "f-codigo-control", text: "Cód. control" }), codigoControl]),
    el("div", { class: "filter" }, [el("label", { class: "filter-label", text: "Código de barras" }), celdaCodigo]),
  ]);
}

// ------------------------------------------------------- Modal detalle
// `onCambio` refresca la lista de fondo cuando se reclasifica una existencia.
function verDetalle(grupo, onCambio) {
  const body = el("div", { class: "modal__body" }, [el("p", { class: "loading", text: "Cargando existencias…" })]);
  const { close } = openModal({
    title: `Detalle — ${grupo.no_parte || grupo.producto_nombre || "Sin no. de parte"}`,
    body,
    submitLabel: "Cerrar",
    readOnly: true,
    size: "wide",
    onSubmit: async (cerrar) => cerrar(),
  });

  cargarDetalle();

  async function cargarDetalle() {
    // La fila de la lista reúne todas las existencias del producto en el
    // almacén; aquí se listan una por una (cada ubicación · estado · código de
    // control) y sus totales cuadran con la fila.
    let q = supabase.from("vw_producto_almacen").select("*").eq("almacen_id", grupo.almacen_id);
    q = grupo.producto_id
      ? q.eq("producto_id", grupo.producto_id)
      : (grupo.no_parte ? q.eq("no_parte", grupo.no_parte) : q.is("no_parte", null));
    const { data: rows, error } = await q.order("estado_nombre").order("ubicacion");

    clear(body);
    if (error) {
      body.appendChild(el("div", { class: "alert alert--error", text: `No se pudo cargar el detalle: ${error.message}` }));
      return;
    }

    const data = rows || [];
    const total = data.reduce((s, r) => s + Number(r.stock_actual || 0), 0);
    const ubicaciones = new Set(data.map((r) => (r.ubicacion || "").trim().toUpperCase())).size;
    body.appendChild(
      el("dl", { class: "ticket__meta" }, [
        el("div", {}, [el("dt", { text: "Almacén" }), el("dd", {}, [badgeAlmacen(grupo.almacen_nombre)])]),
        el("div", {}, [el("dt", { text: "Producto" }), el("dd", { text: grupo.producto_nombre || "—" })]),
        el("div", {}, [el("dt", { text: "No. parte" }), el("dd", { class: "mono", text: grupo.no_parte || "Sin no. de parte" })]),
        el("div", {}, [el("dt", { text: "Stock total" }), el("dd", { class: "mono", text: String(total) })]),
        el("div", {}, [el("dt", { text: "Existencias" }), el("dd", { class: "mono", text: String(data.length) })]),
        el("div", {}, [el("dt", { text: "Ubicaciones" }), el("dd", { class: "mono", text: String(ubicaciones) })]),
      ])
    );

    const columnas = [
      { key: "producto_nombre", label: "Nombre" },
      { key: "no_parte", label: "No. parte", render: (r) => el("span", { class: "mono", text: r.no_parte || "—" }) },
      { key: "no_serie", label: "Serie", render: (r) => el("span", { class: "mono", text: r.no_serie || "—" }) },
      { key: "codigo_control", label: "Cód. control", render: (r) => el("span", { class: "mono", text: r.codigo_control || "—" }) },
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
      buildTable(columnas, data, puedeEditar()
        ? (row) => [iconButton("Cambiar estado", "btn--ghost", () => cambiarEstado(row))]
        : null)
    );
  }

  // Reclasificar una existencia. Si el destino ya existe (mismo estado,
  // ubicación y código de control), el servidor fusiona las dos y desactiva la
  // de origen (salvo en componente trazable, que nunca fusiona).
  async function cambiarEstado(fila) {
    const estados = await cargarCatalogo("estados");
    // Hermanas: todas las existencias del mismo producto en el almacén, para
    // avisar si el nuevo estado/ubicación coincide con otra del mismo lote.
    const { data: hermanas } = await supabase
      .from("vw_producto_almacen").select("*")
      .eq("almacen_id", grupo.almacen_id).eq("producto_id", fila.producto_id);
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

    // Aviso en vivo: si el destino ya existe, esto va a fusionar. La fusión solo
    // ocurre entre existencias del mismo código de control.
    const revisarFusion = () => {
      const est = entradas.estado_id.value ? Number(entradas.estado_id.value) : null;
      const ubi = entradas.ubicacion.value.trim().toUpperCase();
      const cc = (fila.codigo_control || "").trim().toUpperCase();
      const destino = (hermanas || []).find(
        (h) => h.id !== fila.id &&
               (h.estado_id ?? null) === est &&
               (h.ubicacion || "").trim().toUpperCase() === ubi &&
               (h.codigo_control || "").trim().toUpperCase() === cc
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
