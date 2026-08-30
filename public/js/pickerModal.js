// Selector de un solo elemento con filtro, en modal.
//
// Comparte el aspecto y la mecánica del buscador de productos (mismas
// tarjetas, mismo debounce), pero elige UNO y cierra. Se usa para asociar
// una unidad física o un equipo al ticket de movimiento.
import { supabase } from "./supabaseClient.js";
import { el, clear } from "./ui.js";
import { icon } from "./icons.js";

const DEBOUNCE_MS = 300;

// config = {
//   titulo, eyebrow?, placeholder?, tabla, campos: [...columnas para el .or()],
//   orden?, icono?, principal(row) -> texto, detalles(row) -> [{label, valor}],
//   vacio?: texto cuando no hay resultados
// }
export function openPicker({ config, onPick }) {
  const overlay = el("div", { class: "modal-overlay" });
  const results = el("div", {
    class: "search__results", id: "picker-results",
    role: "listbox", "aria-label": "Resultados",
  });
  const status = el("p", { class: "search__status", role: "status", "aria-live": "polite" });

  const input = el("input", {
    class: "search__input", type: "search", id: "picker-input",
    placeholder: config.placeholder || "Buscar…",
    autocomplete: "off", spellcheck: "false", "aria-controls": "picker-results",
  });

  const closeBtn = el("button", {
    class: "modal__close", type: "button", html: "&times;", "aria-label": "Cerrar",
  });

  const panel = el("div", { class: "modal modal--search" }, [
    el("div", { class: "modal__header" }, [
      el("div", {}, [
        el("h3", { class: "modal__title", id: "picker-title", text: config.titulo }),
        config.eyebrow ? el("p", { class: "modal__eyebrow", text: config.eyebrow }) : null,
      ]),
      closeBtn,
    ]),
    el("div", { class: "search__bar" }, [
      el("label", { class: "sr-only", for: "picker-input", text: config.titulo }),
      input,
    ]),
    status,
    results,
  ]);

  overlay.appendChild(panel);
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "picker-title");
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

  let timer;
  let lastToken = 0;

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => buscar(input.value.trim()), DEBOUNCE_MS);
  });

  // Se carga la lista completa de entrada: estos catálogos son cortos y así
  // el usuario ve qué hay sin tener que adivinar un término.
  buscar("");

  async function buscar(term) {
    const token = ++lastToken;
    status.textContent = "Buscando…";

    // Saneado: la sintaxis de .or() usa comas y paréntesis como separadores.
    const safe = term.replace(/[,()*]/g, " ").trim();

    let q = supabase.from(config.tabla).select("*");
    if (safe) q = q.or(config.campos.map((c) => `${c}.ilike.%${safe}%`).join(","));
    q = q.order(config.orden || "id").limit(50);

    const { data, error } = await q;
    if (token !== lastToken) return;

    clear(results);
    if (error) {
      status.textContent = "";
      results.appendChild(el("div", { class: "alert alert--error", text: `No se pudo buscar: ${error.message}` }));
      return;
    }

    status.textContent = `${(data || []).length} resultado(s).`;
    if (!data?.length) {
      results.appendChild(
        el("div", { class: "search__empty" }, [
          el("p", { text: safe ? `Nada coincide con “${term}”.` : (config.vacio || "No hay registros.") }),
        ])
      );
      return;
    }
    for (const row of data) results.appendChild(tarjeta(row));
  }

  function tarjeta(row) {
    const elegir = () => { onPick(row); close(); };

    const card = el("div", { class: "pcard pcard--picker", role: "option", tabindex: "0" }, [
      el("div", { class: "pcard__main" }, [
        el("div", { class: "pcard__name" }, [
          el("span", { class: "pcard__icon", "aria-hidden": "true", html: icon(config.icono || "search", { size: 16, stroke: 1.8 }) }),
          el("span", { text: config.principal(row) || "(sin nombre)" }),
        ]),
        el("div", { class: "pcard__meta" },
          (config.detalles?.(row) || [])
            .filter((d) => d && d.valor)
            .map((d) =>
              el("span", { class: "pcard__chip" }, [
                el("span", { class: "pcard__chip-label", text: `${d.label} ` }),
                el("span", { class: "mono", text: String(d.valor) }),
              ])
            )
        ),
      ]),
      el("div", { class: "pcard__side" }, [
        el("button", { class: "btn btn--primary btn--sm", type: "button", text: "Elegir",
          onclick: (e) => { e.stopPropagation(); elegir(); } }),
      ]),
    ]);

    card.addEventListener("click", elegir);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); elegir(); }
    });
    return card;
  }

  return { close };
}

// ---- Configuraciones listas para usar ----

export const PICKER_PROD_ACTIVO = {
  titulo: "Elegir producto activo",
  placeholder: "Descripción, serie, código interno, producto…",
  tabla: "vw_producto_unidad_lista",
  campos: ["descripcion", "no_serie", "codigo_interno", "producto_nombre", "no_parte", "modelo"],
  orden: "descripcion",
  icono: "wrench",
  vacio: "Todavía no hay unidades registradas.",
  principal: (r) => r.descripcion || r.producto_nombre,
  detalles: (r) => [
    { label: "Producto", valor: r.producto_nombre },
    { label: "Serie", valor: r.no_serie },
    { label: "Cód. interno", valor: r.codigo_interno },
    { label: "Estado", valor: r.estado_nombre },
  ],
};

export const PICKER_UNIDAD_OPERATIVA = {
  titulo: "Elegir unidad operativa",
  placeholder: "Código, nombre, proyecto, ubicación, zona…",
  tabla: "vw_unidad_operativa_lista",
  campos: ["codigo", "nombre", "proyecto", "ubicacion", "zona"],
  orden: "nombre",
  icono: "unidades-operativas",
  vacio: "Todavía no hay unidades operativas registradas.",
  principal: (r) => r.etiqueta || r.nombre,
  detalles: (r) => [
    { label: "Proyecto", valor: r.proyecto },
    { label: "Ubicación", valor: r.ubicacion },
    { label: "Zona", valor: r.zona },
    { label: "Equipos", valor: r.equipos_asignados },
  ],
};

export const PICKER_PROVEEDOR = {
  titulo: "Elegir proveedor",
  placeholder: "Código, razón social, RUC, contacto…",
  tabla: "vw_proveedores_lista",
  campos: ["codigo", "razon_social", "ruc", "contacto"],
  orden: "razon_social",
  icono: "proveedores",
  vacio: "Todavía no hay proveedores registrados.",
  principal: (r) => r.etiqueta || r.razon_social || "(sin nombre)",
  detalles: (r) => [
    { label: "RUC", valor: r.ruc },
    { label: "Contacto", valor: r.contacto },
    { label: "Teléfono", valor: r.telefono },
    { label: "Email", valor: r.email },
  ],
};

export const PICKER_EQUIPO = {
  titulo: "Elegir equipo",
  placeholder: "Modelo, serie, marca, descripción…",
  tabla: "vw_equipos_lista",
  campos: ["modelo", "no_serie", "marca", "descripcion", "unidad_actual"],
  orden: "modelo",
  icono: "equipos",
  vacio: "Todavía no hay equipos registrados.",
  principal: (r) => r.etiqueta || r.modelo || "(sin modelo)",
  detalles: (r) => [
    { label: "Marca", valor: r.marca },
    { label: "Serie", valor: r.no_serie },
    { label: "Unidad", valor: r.unidad_actual },
    { label: "Estado", valor: r.estado_actual },
    { label: "Descripción", valor: r.descripcion },
  ],
};
