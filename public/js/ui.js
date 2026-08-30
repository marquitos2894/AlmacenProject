// Helpers de interfaz: creación de elementos, toasts, modales, tablas y formularios.
import { icon } from "./icons.js";

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "dataset") {
      Object.assign(node.dataset, v);
    } else {
      node.setAttribute(k, v);
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// ---------------------------------------------------------------- Toast
let toastContainer;
export function toast(message, type = "info") {
  if (!toastContainer) {
    // aria-live: los avisos se anuncian sin robar el foco.
    toastContainer = el("div", { class: "toast-container", role: "status", "aria-live": "polite" });
    document.body.appendChild(toastContainer);
  }
  const t = el("div", { class: `toast toast--${type}`, text: message });
  toastContainer.appendChild(t);
  requestAnimationFrame(() => t.classList.add("toast--show"));
  setTimeout(() => {
    t.classList.remove("toast--show");
    setTimeout(() => t.remove(), 250);
  }, 3200);
}

// ---------------------------------------------------------------- Modal
// readOnly: para modales de consulta (ticket, detalle) — un solo botón Cerrar.
// actions: botones extra en el pie, p. ej. [{ label: "Imprimir", onClick }].
export function openModal({ title, subtitle, body, onSubmit, submitLabel = "Guardar", size, readOnly = false, actions = [] }) {
  const overlay = el("div", { class: "modal-overlay" });
  const closeBtn = el("button", { class: "modal__close", type: "button", html: "&times;", "aria-label": "Cerrar" });
  const form = el("form", { class: "modal__form" });

  const footer = el("div", { class: "modal__footer" }, [
    readOnly ? null : el("button", { type: "button", class: "btn btn--ghost", text: "Cancelar", onclick: () => close() }),
    ...actions.map((a) =>
      el("button", {
        type: "button", class: `btn ${a.class || "btn--ghost"}`, text: a.label,
        onclick: a.onClick,
      })
    ),
    el("button", { type: "submit", class: "btn btn--primary", text: submitLabel }),
  ]);

  form.appendChild(body);
  form.appendChild(footer);

  const modal = el("div", { class: `modal ${size ? `modal--${size}` : ""}` }, [
    el("div", { class: "modal__header" }, [
      el("div", { class: "modal__heading" }, [
        el("h3", { class: "modal__title", text: title }),
        subtitle ? el("p", { class: "modal__subtitle", text: subtitle }) : null,
      ]),
      closeBtn,
    ]),
    form,
  ]);
  overlay.appendChild(modal);
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  document.body.appendChild(overlay);
  document.body.classList.add("no-scroll");

  function onEsc(ev) {
    if (ev.key === "Escape") close();
  }
  function close() {
    overlay.remove();
    document.body.classList.remove("no-scroll");
    // Se quita aquí, sin importar cómo se cerró (X, Cancelar o Escape):
    // si solo se quitaba al presionar Escape, cerrar por otra vía dejaba
    // el listener vivo en document para siempre.
    document.removeEventListener("keydown", onEsc);
  }
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onEsc);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submitBtn = footer.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    submitBtn.textContent = "Guardando…";
    try {
      await onSubmit(close);
    } catch (err) {
      toast(err.message || "Ocurrió un error", "error");
      submitBtn.disabled = false;
      submitBtn.textContent = submitLabel;
    }
  });

  requestAnimationFrame(() => overlay.classList.add("modal-overlay--show"));
  const firstField = form.querySelector("input, select, textarea");
  if (firstField) firstField.focus();
  return { close };
}

export function confirmDialog({ title = "Confirmar", message, confirmLabel = "Confirmar", danger = false }) {
  return new Promise((resolve) => {
    const overlay = el("div", { class: "modal-overlay modal-overlay--show" });
    const modal = el("div", { class: "modal modal--sm" }, [
      el("div", { class: "modal__header" }, [el("h3", { class: "modal__title", text: title })]),
      el("div", { class: "modal__body" }, [el("p", { text: message })]),
      el("div", { class: "modal__footer" }, [
        el("button", {
          class: "btn btn--ghost", type: "button", text: "Cancelar",
          onclick: () => { overlay.remove(); resolve(false); },
        }),
        el("button", {
          class: `btn ${danger ? "btn--danger" : "btn--primary"}`, type: "button", text: confirmLabel,
          onclick: () => { overlay.remove(); resolve(true); },
        }),
      ]),
    ]);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  });
}

// ---------------------------------------------------- Combobox multi-select
// Selector con búsqueda y varias opciones a la vez. Lo elegido se muestra
// como chips DENTRO del propio control, así el alto no salta al seleccionar.
//
// Dos decisiones que sostienen la interacción:
//
//  1. El panel hace `preventDefault()` en mousedown. Sin eso el navegador
//     quita el foco del buscador, se dispara `blur`, y el cierre por blur
//     compite contra el `click`: si el blur gana, el panel desaparece antes
//     de que el clic aterrice y la opción NUNCA se selecciona. Al prevenir
//     el mousedown el foco jamás se va y la carrera deja de existir.
//
//  2. El estado vive en casillas ocultas dentro del nodo devuelto, así
//     `readField` lee lo mismo que en un checklist y el evento `change`
//     sigue burbujeando hasta crud.js para los campos condicionales.
function buildSearchMulti(field, id, value) {
  const options = field.options || [];
  const selected = new Set((Array.isArray(value) ? value : []).map(String));

  const root = el("div", { class: "msearch", id });
  const control = el("div", { class: "msearch__control" });
  const chips = el("div", { class: "msearch__chips" });

  const input = el("input", {
    type: "text", class: "msearch__input",
    placeholder: field.placeholder || "Buscar…",
    role: "combobox", "aria-expanded": "false", "aria-haspopup": "listbox",
    "aria-controls": `${id}_listbox`, "aria-labelledby": `${id}_label`,
    "aria-autocomplete": "list", autocomplete: "off", spellcheck: "false",
  });

  const caret = el("span", { class: "msearch__caret", "aria-hidden": "true" });
  const panel = el("div", {
    class: "msearch__panel", role: "listbox", id: `${id}_listbox`,
    "aria-labelledby": `${id}_label`, "aria-multiselectable": "true",
  });
  panel.hidden = true;

  // Fuente de verdad: inputs reales (ocultos) para que `change` burbujee.
  const store = el("div", { class: "sr-only", "aria-hidden": "true" });
  const casillas = new Map();
  for (const opt of options) {
    const cb = el("input", { type: "checkbox", value: String(opt.value) });
    cb.checked = selected.has(String(opt.value));
    store.appendChild(cb);
    casillas.set(String(opt.value), cb);
  }

  const contador = el("span", { class: "msearch__count", "aria-live": "polite" });

  control.appendChild(chips);
  control.appendChild(input);
  control.appendChild(caret);
  root.appendChild(control);
  root.appendChild(panel);
  root.appendChild(contador);
  root.appendChild(store);

  let filtrados = options;
  let activo = -1;

  const elegidos = () => options.filter((o) => casillas.get(String(o.value))?.checked);

  function alternar(valor) {
    const cb = casillas.get(String(valor));
    if (!cb) return;
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
    pintarChips();
    pintarPanel();
  }

  function pintarChips() {
    clear(chips);
    const actuales = elegidos();
    for (const opt of actuales) {
      chips.appendChild(
        el("span", { class: "chip" }, [
          el("span", { class: "chip__label", text: opt.label }),
          el("button", {
            type: "button", class: "chip__remove", "aria-label": `Quitar ${opt.label}`,
            // También aquí: sin preventDefault el chip robaría el foco al buscador.
            onmousedown: (e) => e.preventDefault(),
            onclick: (e) => { e.stopPropagation(); alternar(opt.value); input.focus(); },
          }, "×"),
        ])
      );
    }
    input.placeholder = actuales.length ? "Añadir otro…" : (field.placeholder || "Buscar…");
    contador.textContent = actuales.length
      ? `${actuales.length} seleccionado${actuales.length === 1 ? "" : "s"}`
      : "";
  }

  function pintarPanel() {
    clear(panel);
    const termino = input.value.trim().toLowerCase();
    filtrados = termino ? options.filter((o) => o.label.toLowerCase().includes(termino)) : options;
    activo = filtrados.length ? 0 : -1;

    if (!options.length) {
      panel.appendChild(el("p", { class: "msearch__empty", text: field.emptyText || "No hay opciones disponibles." }));
      return;
    }
    if (!filtrados.length) {
      panel.appendChild(el("p", { class: "msearch__empty", text: `Sin resultados para “${input.value.trim()}”.` }));
      return;
    }
    filtrados.forEach((opt, i) => {
      const marcado = !!casillas.get(String(opt.value))?.checked;
      panel.appendChild(
        el("div", {
          id: `${id}_opt_${opt.value}`, role: "option",
          "aria-selected": marcado ? "true" : "false",
          class: `msearch__option${marcado ? " msearch__option--selected" : ""}`,
          style: `--i:${i}`,
          onclick: () => alternar(opt.value),
        }, [
          el("span", { class: `msearch__box${marcado ? " msearch__box--on" : ""}`, "aria-hidden": "true", text: marcado ? "✓" : "" }),
          el("span", { class: "msearch__label", text: opt.label }),
        ])
      );
    });
    marcarActivo();
  }

  function marcarActivo() {
    const nodos = panel.querySelectorAll(".msearch__option");
    nodos.forEach((n, i) => n.classList.toggle("msearch__option--active", i === activo));
    if (activo >= 0 && filtrados[activo]) {
      input.setAttribute("aria-activedescendant", `${id}_opt_${filtrados[activo].value}`);
      nodos[activo]?.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function abrir() {
    if (!panel.hidden) return;
    panel.hidden = false;
    root.classList.add("msearch--open");
    input.setAttribute("aria-expanded", "true");
    pintarPanel();
  }
  function cerrar() {
    if (panel.hidden) return;
    panel.hidden = true;
    root.classList.remove("msearch--open");
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  // Clic en cualquier parte del control lleva el foco al buscador.
  control.addEventListener("mousedown", (e) => {
    if (e.target !== input) {
      e.preventDefault();
      input.focus();
    }
    abrir();
  });

  // LA CLAVE: el panel nunca roba el foco, así no hay `blur` ni carrera.
  panel.addEventListener("mousedown", (e) => e.preventDefault());

  input.addEventListener("focus", () => { root.classList.add("msearch--focus"); abrir(); });
  input.addEventListener("blur", () => { root.classList.remove("msearch--focus"); cerrar(); });
  input.addEventListener("input", () => { abrir(); pintarPanel(); });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (panel.hidden) return abrir();
      if (filtrados.length) { activo = (activo + 1) % filtrados.length; marcarActivo(); }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (panel.hidden || !filtrados.length) return;
      activo = (activo - 1 + filtrados.length) % filtrados.length;
      marcarActivo();
    } else if (e.key === "Enter") {
      e.preventDefault();   // no debe enviar el formulario del modal
      if (!panel.hidden && filtrados[activo]) alternar(filtrados[activo].value);
    } else if (e.key === "Escape") {
      if (!panel.hidden) { e.stopPropagation(); cerrar(); }
    } else if (e.key === "Backspace" && !input.value) {
      const actuales = elegidos();
      if (actuales.length) alternar(actuales[actuales.length - 1].value);
    }
  });

  pintarChips();
  return root;
}

// ---------------------------------------------------------- Form fields
// field: { name, label, type, options?, required?, value? }
export function buildField(field, value) {
  const id = `f_${field.name}`;
  let input;
  const v = value ?? field.value ?? "";

  if (field.type === "textarea") {
    input = el("textarea", { id, name: field.name, class: "input", rows: "3" });
    input.value = v ?? "";
  } else if (field.type === "select") {
    input = el("select", { id, name: field.name, class: "input" });
    input.appendChild(el("option", { value: "", text: field.placeholder || "— Selecciona —" }));
    for (const opt of field.options || []) {
      const o = el("option", { value: String(opt.value), text: opt.label });
      if (String(opt.value) === String(v)) o.selected = true;
      input.appendChild(o);
    }
  } else if (field.type === "multiselect") {
    input = el("select", { id, name: field.name, class: "input input--multi", multiple: "multiple", size: "5" });
    const selected = new Set((Array.isArray(v) ? v : []).map(String));
    for (const opt of field.options || []) {
      const o = el("option", { value: String(opt.value), text: opt.label });
      if (selected.has(String(opt.value))) o.selected = true;
      input.appendChild(o);
    }
  } else if (field.type === "checklist") {
    input = buildSearchMulti(field, id, v);
  } else if (field.type === "checkbox") {
    // Interruptor: el <input> real sigue siendo la casilla (lo lee readField y
    // lo observan los campos condicionales); la pista visual es el <span>.
    input = el("input", { id, name: field.name, type: "checkbox", class: "switch__input" });
    input.checked = v === true || v === "true";
    const wrap = el("div", { class: "form-row form-row--switch" }, [
      el("div", { class: "switch-field" }, [
        el("label", { class: "switch", for: id }, [
          input,
          el("span", { class: "switch__track", "aria-hidden": "true" }),
        ]),
        el("div", { class: "switch-field__text" }, [
          el("label", { class: "form-label", for: id, text: field.label }),
          field.hint ? el("small", { class: "form-hint", text: field.hint }) : null,
        ]),
      ]),
    ]);
    return { wrap, input };
  } else {
    input = el("input", {
      id, name: field.name, class: "input",
      type: field.type || "text",
      step: field.type === "number" ? (field.step || "any") : null,
      placeholder: field.placeholder || null,
    });
    input.value = v ?? "";
  }

  if (field.required && field.type !== "checklist") input.required = true;

  // El checklist es un <div role="group">, no un control de formulario: la
  // etiqueta no puede usar `for` (no hay nada que enfocar), así que se asocia
  // por aria-labelledby en su lugar.
  const etiqueta = field.type === "checklist"
    ? el("span", { class: "form-label", id: `${id}_label`, text: field.label + (field.required ? " *" : "") })
    : el("label", { class: "form-label", for: id, text: field.label + (field.required ? " *" : "") });

  const wrap = el("div", { class: `form-row ${field.type === "checkbox" ? "form-row--inline" : ""}` }, [
    etiqueta,
    input,
    field.hint ? el("small", { class: "form-hint", text: field.hint }) : null,
  ]);
  return { wrap, input };
}

// Lee el valor de un input construido con buildField
export function readField(field, input) {
  if (field.type === "checkbox") return input.checked;
  if (field.type === "multiselect") {
    return Array.from(input.selectedOptions).map((o) =>
      isNaN(Number(o.value)) ? o.value : Number(o.value)
    );
  }
  if (field.type === "checklist") {
    return Array.from(input.querySelectorAll("input[type=checkbox]:checked")).map((cb) =>
      isNaN(Number(cb.value)) ? cb.value : Number(cb.value)
    );
  }
  const raw = input.value.trim();
  if (raw === "") return null;
  if (field.type === "number") return Number(raw);
  if (field.type === "select" && !isNaN(Number(raw))) return Number(raw);
  return raw;
}

// -------------------------------------------------------------- Tabla
// columns: [{ key, label, render?(row) }]
export function buildTable(columns, rows, actions) {
  const thead = el("thead", {}, [
    el("tr", {}, [
      ...columns.map((c) => el("th", { text: c.label })),
      actions ? el("th", { class: "col-actions", text: "Acciones" }) : null,
    ]),
  ]);

  const body = el("tbody");
  if (!rows.length) {
    body.appendChild(
      el("tr", {}, [
        el("td", { colspan: String(columns.length + (actions ? 1 : 0)), class: "empty", text: "Sin registros." }),
      ])
    );
  }
  for (const row of rows) {
    const tds = columns.map((c) => {
      const td = el("td");
      const content = c.render ? c.render(row) : row[c.key];
      if (content instanceof Node) td.appendChild(content);
      else td.textContent = content == null || content === "" ? "—" : String(content);
      return td;
    });
    if (actions) {
      const cell = el("td", { class: "col-actions" });
      actions(row).forEach((btn) => cell.appendChild(btn));
      tds.push(cell);
    }
    body.appendChild(el("tr", {}, tds));
  }

  return el("div", { class: "table-wrap" }, [el("table", { class: "table" }, [thead, body])]);
}

// `iconName` (opcional) lo convierte en un botón cuadrado con solo el icono; la
// etiqueta pasa a tooltip y a aria-label. Sin él, se comporta como antes.
export function iconButton(label, cls, onClick, iconName) {
  if (!iconName) {
    return el("button", { class: `btn btn--sm ${cls}`, type: "button", text: label, onclick: onClick });
  }
  return el("button", {
    class: `btn btn--sm btn--icon ${cls}`, type: "button",
    onclick: onClick, title: label, "aria-label": label,
    html: icon(iconName, { size: 15, stroke: 1.8 }),
  });
}

// ------------------------------------------------------------ Impresión
// Manda al papel solo el elemento marcado con `.zona-impresion`; el resto de
// la página se oculta por CSS mientras dura la impresión.
export function imprimirZona() {
  document.body.classList.add("imprimiendo");
  const limpiar = () => {
    document.body.classList.remove("imprimiendo");
    window.removeEventListener("afterprint", limpiar);
  };
  window.addEventListener("afterprint", limpiar);
  window.print();
  // Safari no siempre dispara afterprint: red de seguridad.
  setTimeout(limpiar, 1500);
}
