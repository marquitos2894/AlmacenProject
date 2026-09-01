// Modal de búsqueda con autocompletado. Tiene dos modos:
//
//   modo "entrada"  -> busca PRODUCTOS del catálogo. El usuario indica a qué
//                      estado y ubicación entran; si no existe esa combinación
//                      se creará una existencia nueva.
//   modo "salida"   -> busca EXISTENCIAS reales del almacén (producto + estado
//                      + ubicación + stock). Hay que descontar de una existencia
//                      concreta, así que no basta con elegir el producto.
//
import { supabase } from "./supabaseClient.js";
import { el, clear, toast } from "./ui.js";
import { icon } from "./icons.js";
import { openForm } from "./crud.js";
import { productoFormConfig } from "./productoForm.js";
import { botonEscanear } from "./scanner.js";
import { badgeStock } from "./badges.js";

const DEBOUNCE_MS = 300;

// onPick(item) donde item = { producto, cantidad, estado_id, ubicacion, producto_almacen_id? }
export function openProductSearch({ almacenId, almacenNombre, modo = "entrada", estados = [], onPick }) {
  const esSalida = modo === "salida";

  const overlay = el("div", { class: "modal-overlay" });
  const results = el("div", {
    class: "search__results", id: "search-results",
    role: "listbox", "aria-label": "Resultados de la búsqueda",
  });
  const status = el("p", { class: "search__status", role: "status", "aria-live": "polite" });

  const input = el("input", {
    class: "search__input", type: "search", id: "search-input",
    placeholder: esSalida ? "No. de parte, nombre, serie, ubicación o código…" : "No. de parte, nombre, serie, código…",
    autocomplete: "off", spellcheck: "false", "aria-controls": "search-results",
  });

  const closeBtn = el("button", {
    class: "modal__close", type: "button", html: "&times;", "aria-label": "Cerrar búsqueda",
  });

  const panel = el("div", { class: "modal modal--search" }, [
    el("div", { class: "modal__header" }, [
      el("div", {}, [
        el("h3", { class: "modal__title", id: "search-title", text: esSalida ? "Elegir existencia" : "Agregar producto" }),
        el("p", { class: "modal__eyebrow", text: almacenNombre ? `Almacén ${almacenNombre}` : "" }),
      ]),
      closeBtn,
    ]),
    el("div", { class: "search__bar" }, [
      el("label", { class: "sr-only", for: "search-input", text: "Buscar" }),
      el("div", { class: "search__bar-row" }, [
        input,
        // Al escanear, se rellena el campo y se dispara el mismo flujo que teclear.
        botonEscanear((codigo) => {
          input.value = codigo;
          input.dispatchEvent(new Event("input"));
        }, { texto: true }),
      ]),
    ]),
    status,
    results,
  ]);

  overlay.appendChild(panel);
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "search-title");
  document.body.appendChild(overlay);
  document.body.classList.add("no-scroll");
  requestAnimationFrame(() => {
    overlay.classList.add("modal-overlay--show");
    input.focus();
  });

  function close() {
    overlay.remove();
    document.body.classList.remove("no-scroll");
    document.removeEventListener("keydown", onEsc);
  }
  function onEsc(e) { if (e.key === "Escape") close(); }
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onEsc);

  showIdle();
  let timer;
  let lastToken = 0;

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const term = input.value.trim();
    if (term.length < 2) { showIdle(); return; }
    status.textContent = "Buscando…";
    timer = setTimeout(() => (esSalida ? buscarExistencias(term) : buscarProductos(term)), DEBOUNCE_MS);
  });

  function showIdle() {
    clear(results);
    status.textContent = "";
    results.appendChild(
      el("div", { class: "search__empty" }, [
        el("p", { text: "Escribe al menos 2 caracteres para buscar." }),
        el("p", {
          class: "search__hint",
          text: esSalida
            ? "Se listan las existencias de este almacén, con su estado y ubicación."
            : "Busca por no. de parte, nombre, serie, código de barras o código interno.",
        }),
      ])
    );
  }

  // Saneado: la sintaxis de .or() usa comas y paréntesis como separadores.
  const sanear = (t) => t.replace(/[,()*]/g, " ").trim();

  // ------------------------------------------------- modo salida
  async function buscarExistencias(term) {
    const token = ++lastToken;
    const safe = sanear(term);
    if (!safe) return;

    const { data, error } = await supabase
      .from("vw_producto_almacen")
      .select("*")
      .eq("almacen_id", almacenId)
      .gt("stock_actual", 0)
      .or(`no_parte.ilike.%${safe}%,producto_nombre.ilike.%${safe}%,no_serie.ilike.%${safe}%,ubicacion.ilike.%${safe}%,codigo_barras.ilike.%${safe}%`)
      .order("producto_nombre")
      .limit(25);

    if (token !== lastToken) return;
    if (error) return mostrarError(error);

    clear(results);
    status.textContent = `${(data || []).length} existencia(s).`;

    if (!data?.length) {
      results.appendChild(
        el("div", { class: "search__empty" }, [
          el("p", { text: `Ninguna existencia con stock coincide con “${term}”.` }),
          el("p", { class: "search__hint", text: "Para dar de alta stock, registra una entrada." }),
        ])
      );
      return;
    }
    for (const ex of data) results.appendChild(tarjetaExistencia(ex));
  }

  function tarjetaExistencia(ex) {
    const qty = el("input", {
      class: "input input--qty", type: "number", min: "0.01", step: "any",
      max: String(ex.stock_actual), value: "1",
      "aria-label": `Cantidad a retirar de ${ex.producto_nombre}`,
      onclick: (e) => e.stopPropagation(),
    });

    const agregar = () => {
      const n = Number(qty.value);
      if (!(n > 0)) { toast("La cantidad debe ser mayor que cero.", "error"); qty.focus(); return; }
      if (n > Number(ex.stock_actual)) {
        toast(`Solo hay ${ex.stock_actual} en ${ex.ubicacion || "esa ubicación"}.`, "error");
        qty.focus(); return;
      }
      onPick({
        producto: {
          id: ex.producto_id, nombre: ex.producto_nombre, no_parte: ex.no_parte,
          no_serie: ex.no_serie, codigo_barras: ex.codigo_barras, es_trazable: ex.es_trazable,
        },
        cantidad: n,
        estado_id: ex.estado_id,
        ubicacion: ex.ubicacion,
        producto_almacen_id: ex.id,
      });
      toast(`“${ex.producto_nombre}” agregado al ticket.`, "success");
      input.value = "";
      input.focus();
      showIdle();
    };

    const card = el("div", { class: "pcard", role: "option", tabindex: "0" }, [
      el("div", { class: "pcard__main" }, [
        el("div", { class: "pcard__name" }, [
          el("span", { class: "pcard__icon", "aria-hidden": "true", html: icon("productos", { size: 16, stroke: 1.8 }) }),
          el("span", { text: ex.producto_nombre }),
        ]),
        el("div", { class: "pcard__meta" }, [
          chip("No. parte", ex.no_parte),
          chip("Serie", ex.no_serie),
          chip("Ubicación", ex.ubicacion),
          ex.estado_nombre ? el("span", { class: "badge badge--estado", text: ex.estado_nombre }) : null,
          ex.es_trazable ? el("span", { class: "badge badge--fijo", text: "Componente" }) : null,
        ]),
      ]),
      el("div", { class: "pcard__side" }, [
        badgeStock(ex.stock_actual, { prefijo: "Stock: " }),
        el("div", { class: "pcard__actions" }, [
          qty,
          el("button", {
            class: "btn btn--primary btn--sm", type: "button", text: "Agregar",
            onclick: (e) => { e.stopPropagation(); agregar(); },
          }),
        ]),
      ]),
    ]);

    card.addEventListener("click", agregar);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); agregar(); }
    });
    return card;
  }

  // ------------------------------------------------ modo entrada
  async function buscarProductos(term) {
    const token = ++lastToken;
    const safe = sanear(term);
    if (!safe) return;

    // La vista trae serie y código interno de la unidad física, que ya no
    // viven en `productos`, para poder buscar por los cinco campos.
    const { data, error } = await supabase
      .from("vw_productos_busqueda")
      .select("*")
      .eq("activo", true)
      .or(
        `no_parte.ilike.%${safe}%,nombre.ilike.%${safe}%,no_serie.ilike.%${safe}%,` +
        `codigo_barras.ilike.%${safe}%,codigo_interno.ilike.%${safe}%`
      )
      .limit(25);

    if (token !== lastToken) return;
    if (error) return mostrarError(error);

    // Existencias de esos productos: stock en este almacén (por estado/ubicación)
    // y, para los activos fijos, en qué otro almacén ya están asignados.
    const ids = (data || []).map((p) => p.id);
    const existencias = new Map(); // producto_id -> [filas de stock de este almacén]
    const otroMap = new Map();     // producto_id -> nombre de otro almacén
    const globalMap = new Map();   // producto_id -> stock total en TODOS los almacenes
    if (ids.length) {
      const { data: stocks } = await supabase
        .from("producto_almacen")
        .select("id, producto_id, almacen_id, estado_id, ubicacion, stock_actual, almacenes(nombre)")
        .eq("activo", true)
        .in("producto_id", ids);

      for (const s of stocks || []) {
        // La regla del activo fijo mira todo el inventario, no solo este almacén.
        globalMap.set(s.producto_id, (globalMap.get(s.producto_id) || 0) + Number(s.stock_actual || 0));
        if (String(s.almacen_id) === String(almacenId)) {
          if (!existencias.has(s.producto_id)) existencias.set(s.producto_id, []);
          existencias.get(s.producto_id).push(s);
        } else if (!otroMap.has(s.producto_id)) {
          otroMap.set(s.producto_id, s.almacenes?.nombre || `Almacén ${s.almacen_id}`);
        }
      }
    }

    clear(results);
    status.textContent = `${(data || []).length} resultado(s).`;

    if (!data?.length) {
      results.appendChild(
        el("div", { class: "search__empty" }, [
          el("p", { text: `Ningún producto coincide con “${term}”.` }),
          el("button", {
            class: "btn btn--primary", type: "button", text: "Crear producto nuevo",
            onclick: () => crearRapido(term),
          }),
        ])
      );
      return;
    }

    for (const p of data) {
      results.appendChild(
        tarjetaProducto(p, existencias.get(p.id) || [], otroMap.get(p.id), globalMap.get(p.id) || 0)
      );
    }
    results.appendChild(
      el("div", { class: "search__footer" }, [
        el("span", { class: "search__hint", text: "¿No está en la lista?" }),
        el("button", {
          class: "btn btn--ghost btn--sm", type: "button", text: "Crear producto nuevo",
          onclick: () => crearRapido(term),
        }),
      ])
    );
  }

  function tarjetaProducto(p, filas, otroAlmacen, totalGlobal = null) {
    const total = filas.reduce((s, f) => s + Number(f.stock_actual || 0), 0);

    // Un activo fijo que ya está en inventario es una unidad física única:
    // no puede volver a entrar, solo salir. Con stock 0 vuelve a admitirse.
    const stockGlobal = totalGlobal ?? total;
    const fijoOcupado = p.es_trazable && stockGlobal > 0;

    // Estado y ubicación de destino: definen a qué existencia entra.
    const selEstado = el("select", {
      class: "input input--mini", "aria-label": `Estado de ${p.nombre}`,
      onclick: (e) => e.stopPropagation(),
    }, [
      el("option", { value: "", text: "Sin estado" }),
      ...estados.map((e2) => el("option", { value: String(e2.id), text: e2.nombre })),
    ]);
    const inpUbic = el("input", {
      class: "input input--mini", type: "text", placeholder: "Ubicación…",
      "aria-label": `Ubicación de ${p.nombre}`, autocomplete: "off",
      list: "ubicaciones-sugeridas",
      onclick: (e) => e.stopPropagation(),
    });
    const qty = el("input", {
      class: "input input--qty", type: "number", min: "0.01", step: "any", value: "1",
      "aria-label": `Cantidad de ${p.nombre}`, onclick: (e) => e.stopPropagation(),
    });

    // Si ya existe una sola combinación, se propone como destino por omisión.
    if (filas.length === 1) {
      selEstado.value = filas[0].estado_id != null ? String(filas[0].estado_id) : "";
      inpUbic.value = filas[0].ubicacion || "";
    }

    const agregar = () => {
      if (fijoOcupado) {
        toast(`“${p.nombre}” es un componente y ya está en inventario. Solo admite salidas.`, "error");
        return;
      }
      const n = Number(qty.value);
      if (!(n > 0)) { toast("La cantidad debe ser mayor que cero.", "error"); qty.focus(); return; }
      if (p.es_trazable && otroAlmacen) {
        toast(`“${p.nombre}” es un componente y está en ${otroAlmacen}. Dale salida allí primero.`, "error");
        return;
      }
      onPick({
        producto: p,
        cantidad: n,
        estado_id: selEstado.value ? Number(selEstado.value) : null,
        ubicacion: inpUbic.value.trim() || null,
        producto_almacen_id: null,
      });
      toast(`“${p.nombre}” agregado al ticket.`, "success");
      input.value = "";
      input.focus();
      showIdle();
    };

    const card = el("div", {
      class: `pcard pcard--entrada${fijoOcupado ? " pcard--bloqueada" : ""}`,
      role: "option", tabindex: "0", "aria-disabled": fijoOcupado ? "true" : null,
    }, [
      el("div", { class: "pcard__main" }, [
        el("div", { class: "pcard__name" }, [
          el("span", { class: "pcard__icon", "aria-hidden": "true", html: icon("productos", { size: 16, stroke: 1.8 }) }),
          el("span", { text: p.nombre }),
          p.es_trazable ? el("span", { class: "badge badge--fijo", text: "Componente" }) : null,
        ]),
        el("div", { class: "pcard__meta" }, [
          chip("No. parte", p.no_parte),
          chip("Serie", p.no_serie),
          chip("Cód. interno", p.codigo_interno),
          chip("Cód. barras", p.codigo_barras),
        ]),
        // Desglose de dónde está hoy, para no fragmentar el stock sin querer.
        filas.length
          ? el("div", { class: "pcard__stock" }, filas.map((f) =>
              el("span", { class: "pcard__loc" }, [
                el("span", { class: "mono", text: f.ubicacion || "sin ubicación" }),
                el("span", { class: "pcard__loc-qty mono", text: String(f.stock_actual) }),
              ])
            ))
          : null,
        fijoOcupado
          ? el("p", { class: "pcard__warn", text: "Ya está en inventario. Un componente solo vuelve a entrar si su stock queda en cero." })
          : otroAlmacen
            ? el("p", { class: "pcard__warn", text: `Ya está en ${otroAlmacen}.` })
            : null,
        fijoOcupado ? null : el("div", { class: "pcard__destino" }, [
          el("span", { class: "pcard__chip-label", text: "Entra a" }),
          selEstado,
          inpUbic,
        ]),
      ]),
      el("div", { class: "pcard__side" }, [
        filas.length
          ? badgeStock(total, { prefijo: "Stock: " })
          : el("span", { class: "badge badge--nostock", text: "Sin existencia" }),
        fijoOcupado ? null : el("div", { class: "pcard__actions" }, [
          qty,
          el("button", {
            class: "btn btn--primary btn--sm", type: "button", text: "Agregar",
            onclick: (e) => { e.stopPropagation(); agregar(); },
          }),
        ]),
      ]),
    ]);

    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); agregar(); }
    });
    return card;
  }

  // ---- Alta de producto con el MISMO formulario que la vista Productos.
  // Se reutiliza `openForm` + `productoFormConfig` para no mantener dos altas
  // distintas: así el trazable, la unidad de medida, los equipos compatibles y
  // el guardado de la unidad física (set_producto_unidad) funcionan igual aquí.
  function crearRapido(term) {
    const cfg = {
      ...productoFormConfig,
      // Precarga el nombre con lo que se escribió en el buscador.
      fields: productoFormConfig.fields.map((f) =>
        f.name === "nombre" ? { ...f, default: term } : f
      ),
    };
    openForm(cfg, null, (creado) => {
      // openForm cierra su modal y llama aquí tras guardar: se vuelve a la lista
      // con el producto nuevo para que el usuario le ponga estado y ubicación.
      const nombre = creado?.nombre || term;
      input.value = nombre;
      toast(`“${nombre}” creado. Indica estado y ubicación para agregarlo.`, "success");
      buscarProductos(nombre);
    });
  }

  function mostrarError(error) {
    status.textContent = "";
    clear(results);
    results.appendChild(el("div", { class: "alert alert--error", text: `No se pudo buscar: ${error.message}` }));
  }

  return { close };
}

function chip(label, value) {
  if (!value) return null;
  return el("span", { class: "pcard__chip" }, [
    el("span", { class: "pcard__chip-label", text: `${label} ` }),
    el("span", { class: "mono", text: value }),
  ]);
}
