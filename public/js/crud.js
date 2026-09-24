import { supabase } from "./supabaseClient.js";
import {
  el, clear, toast, openModal, confirmDialog,
  buildField, readField, buildTable, iconButton, buildPaginador,
} from "./ui.js";
import { icon } from "./icons.js";
import { puedeEditar } from "./auth.js";
import { botonEscanear } from "./scanner.js";

// Crea una pantalla CRUD estándar (soft-delete) a partir de una config.
//
// config = {
//   table: 'unidades_medida',
//   title: 'Unidades de medida',
//   singular: 'unidad de medida',
//   orderBy: 'nombre',
//   columns: [{ key, label, render? }],
//   fields:  [{ name, label, type, options?, required?, source? }],
//   hooks: { beforeSave?, afterSave?, loadRelated?(record) }  // opcionales
// }
//
// Los campos select/multiselect pueden declarar `source: { table, value:'id', label:'nombre', filterActive:true }`
// y sus opciones se cargan automáticamente.
// `segments` (opcional) parte la lista en dos o más pestañas sobre una misma
// columna: { key, options: [{ value, label }] }. El valor elegido sobrevive a
// los re-render, para no volver a la primera pestaña tras guardar.
//
// Cada opción puede además leer de otra fuente y mostrar otras columnas
// (`table` y `columns`), útil cuando una pestaña necesita datos unidos de
// otra tabla. Guardar y desactivar siguen yendo a `config.table`.
//
// `search` (opcional) añade una barra de búsqueda sobre la lista:
// { fields: ['nombre', 'no_parte'], placeholder?: '…' }. Filtra con ilike sobre
// esas columnas (deben existir en todas las fuentes de las pestañas).
//
// Una opción de `segments` puede además traer `card: (row, ctx) => Node` (junto
// con `columns`): la lista de esa pestaña se dibuja como cuadrícula de tarjetas
// y aparece un conmutador "Ver tabla / Ver tarjetas". `ctx` = { rerender,
// editar(row), desactivar(row), editable }.
export function createCrudView(config) {
  let segmentoActivo = config.segments?.options?.[0]?.value;
  let termino = "";
  // "tarjetas" | "tabla" | "dashboard". Antes era un booleano tarjetas/tabla;
  // una opción de segmento puede además traer `dashboard(container, rerender)`
  // (mismo patrón que la pestaña Dashboard de Equipos) para sumar un tercer modo.
  let modo = "tarjetas";
  let pagina = 0; // sobrevive a los re-render (p. ej. tras guardar se sigue en la misma página)

  return {
    async render(root) {
      clear(root);
      const rerender = () => this.render(root);
      const opcion = config.segments?.options?.find((o) => o.value === segmentoActivo);

      const puedeTarjetas = !!(opcion?.card && opcion?.columns);
      const puedeDashboard = typeof opcion?.dashboard === "function";
      const modos = [
        ...(puedeTarjetas ? [{ id: "tarjetas", label: "Tarjetas", icon: "grid" }] : []),
        { id: "tabla", label: "Tabla", icon: "table" },
        ...(puedeDashboard ? [{ id: "dashboard", label: "Dashboard", icon: "dashboard" }] : []),
      ];
      // Cambiar de pestaña puede dejar el modo actual sin sentido (p. ej. una
      // pestaña sin dashboard mientras se estaba viendo el de otra).
      if (!modos.some((m) => m.id === modo)) modo = modos[0].id;
      const mostrarTarjetas = modo === "tarjetas" && puedeTarjetas;

      const toggle = modos.length > 1 ? buildModoTabs(modos, modo, (m) => { modo = m; rerender(); }) : null;

      // Al crear desde una pestaña, el registro nace con ese tipo: pulsar
      // "Nuevo" en Trazables no debería dar de alta un consumible.
      root.appendChild(
        buildHeader(config, () => openForm(config, null, rerender, segmentoActivo), toggle)
      );

      if (config.segments) {
        root.appendChild(
          buildSegments(config.segments, segmentoActivo, (valor) => {
            segmentoActivo = valor;
            pagina = 0; // otra pestaña, otra lista
            this.render(root);
          })
        );
      }

      if (modo === "dashboard") {
        const dashContainer = el("div", {}, [el("p", { class: "loading", text: "Cargando…" })]);
        root.appendChild(dashContainer);
        await opcion.dashboard(dashContainer, rerender);
        return;
      }

      const listContainer = el("div", mostrarTarjetas ? {} : { class: "card" }, [el("div", { class: "loading", text: "Cargando…" })]);

      // Solo refresca la lista (no reconstruye barra ni cabecera), para no
      // perder el foco del buscador ni el scroll al cambiar de página.
      const irAPagina = (p) => {
        pagina = p;
        refreshList(config, listContainer, rerender, segmentoActivo, opcion, termino, mostrarTarjetas, pagina, irAPagina);
      };

      // Una opción de segmento puede sumar sus propios filtros (más allá de la
      // búsqueda genérica de `config.search`) — p. ej. Componentes reutiliza
      // el mismo combo de modelo/estado/tipo en Tarjetas, Tabla y Dashboard.
      // `applyFilters(query)` (abajo, en refreshList) es quien de verdad los
      // aplica a la consulta; este solo pinta el control.
      if (opcion?.filtrosExtra) {
        root.appendChild(
          await opcion.filtrosExtra(() => {
            pagina = 0;
            refreshList(config, listContainer, rerender, segmentoActivo, opcion, termino, mostrarTarjetas, pagina, irAPagina);
          })
        );
      }

      if (config.search) {
        root.appendChild(
          buildSearchBar(config.search, termino, (valor) => {
            termino = valor;
            pagina = 0; // el filtro cambió: vuelve al principio
            refreshList(config, listContainer, rerender, segmentoActivo, opcion, termino, mostrarTarjetas, pagina, irAPagina);
          })
        );
      }

      root.appendChild(listContainer);
      await refreshList(config, listContainer, rerender, segmentoActivo, opcion, termino, mostrarTarjetas, pagina, irAPagina);
    },
  };
}

function buildSearchBar(search, valor, onChange) {
  const input = el("input", {
    class: "listbar__input", type: "search", value: valor,
    placeholder: search.placeholder || "Buscar…",
    autocomplete: "off", spellcheck: "false", "aria-label": search.placeholder || "Buscar",
    oninput: debounce((e) => onChange(e.target.value), 250),
  });
  // Botón de cámara: al escanear rellena el mismo `onChange` que teclear.
  const scan = botonEscanear((codigo) => { input.value = codigo; onChange(codigo); });

  return el("div", { class: "listbar" }, [
    el("div", { class: "listbar__search" }, [
      el("span", { class: "listbar__icon", "aria-hidden": "true", html: icon("search", { size: 16, stroke: 2 }) }),
      input,
    ]),
    scan,
  ]);
}

function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function buildSegments(segments, activo, onChange) {
  const grupo = el("div", {
    class: "segments", role: "tablist",
    "aria-label": segments.label || "Filtrar lista",
  });

  // La pestaña activa se guarda dentro del propio control y las clases se
  // repintan al cambiar. Así funciona igual tanto si quien llama vuelve a
  // renderar todo (crud.js) como si solo refresca la lista de debajo
  // (Stock por almacén): sin esto, el botón que arrancó activo quedaba
  // “congelado” y dejaba de responder al volver a él.
  let actual = activo;
  const botones = segments.options.map((opt) => {
    const btn = el("button", {
      type: "button", class: "segments__btn", role: "tab",
      onclick: () => {
        if (opt.value === actual) return;
        actual = opt.value;
        sincronizar();
        onChange(opt.value);
      },
    }, [
      el("span", { text: opt.label }),
      opt.hint ? el("span", { class: "segments__hint", text: opt.hint }) : null,
    ]);
    grupo.appendChild(btn);
    return { btn, value: opt.value };
  });

  function sincronizar() {
    for (const { btn, value } of botones) {
      const on = value === actual;
      btn.classList.toggle("segments__btn--on", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }
  }
  sincronizar();

  return grupo;
}

// Pestañas de vista (Tarjetas/Tabla/Dashboard) — mismas clases que ya usa el
// dashboard de Equipos (public/js/views/equipos.js), generalizadas aquí para
// que cualquier vista con `createCrudView` pueda sumar un modo "dashboard".
function buildModoTabs(modos, activo, onChange) {
  return el("div", { class: "view-tabs" }, modos.map((m) =>
    el("button", {
      class: `view-tabs__btn${activo === m.id ? " view-tabs__btn--active" : ""}`,
      type: "button",
      html: `${icon(m.icon, { size: 14, stroke: 1.9 })}<span>${m.label}</span>`,
      onclick: () => onChange(m.id),
    })
  ));
}

function buildHeader(config, onNew, extra) {
  return el("div", { class: "page-header" }, [
    el("div", {}, [
      el("h2", { class: "page-title", text: config.title }),
      el("p", { class: "page-subtitle", text: `Mantenimiento de ${config.singular || config.title.toLowerCase()}.` }),
    ]),
    el("div", { class: "page-header__actions" }, [
      extra || null,
      puedeEditar() ? el("button", { class: "btn btn--primary", text: "+ Nuevo", onclick: onNew }) : null,
    ]),
  ]);
}

const PAGE_DEFAULT = 50;

async function refreshList(config, container, rerender, segmentoActivo, opcion, termino = "", mostrarTarjetas = false, pagina = 0, irAPagina = null) {
  clear(container);
  // Una tarjeta ocupa mucho más que una fila de tabla: una pestaña puede
  // pedir menos por página en ese modo (p. ej. Componentes en Tarjetas).
  const PAGE = (mostrarTarjetas && opcion?.cardPageSize) || PAGE_DEFAULT;
  // La pestaña puede leer de una vista distinta (con datos unidos); las
  // escrituras siguen yendo a config.table.
  const orden = config.orderBy || "id";
  let query = supabase
    .from(opcion?.table || config.table)
    .select("*", { count: "exact" })
    .eq("activo", true)
    .order(orden, { ascending: true });
  // Desempate por id: `nombre`/`codigo` no son únicos y sin esto la paginación
  // podría repetir u omitir filas con el mismo valor entre páginas.
  if (orden !== "id") query = query.order("id", { ascending: true });

  if (config.segments && segmentoActivo !== undefined) {
    query = query.eq(config.segments.key, segmentoActivo);
  }

  // Filtros propios de la pestaña (más allá de la búsqueda genérica de abajo).
  if (opcion?.applyFilters) query = opcion.applyFilters(query);

  // Búsqueda: ilike sobre las columnas declaradas. Se sanea el término porque
  // las comas y paréntesis son separadores en la sintaxis de .or().
  // Una opción de segmento puede traer sus propias `searchFields` (p. ej. una
  // pestaña que lee de una vista con columnas que la otra no tiene).
  const busca = config.search ? termino.replace(/[,()*]/g, " ").trim() : "";
  const searchFields = opcion?.searchFields || config.search?.fields;
  if (busca && searchFields) {
    query = query.or(searchFields.map((f) => `${f}.ilike.%${busca}%`).join(","));
  }

  query = query.range(pagina * PAGE, pagina * PAGE + PAGE - 1);

  // La lista y las etiquetas de columnas (ids -> nombres) no dependen entre
  // sí: pedirlas a la vez recorta a un solo viaje lo que antes eran varios en
  // fila, y este bloque se repite en cada cambio de pestaña y cada guardado.
  const [{ data, error, count }, resolvers] = await Promise.all([
    query,
    buildColumnResolvers(config),
  ]);
  if (error) {
    container.appendChild(el("div", { class: "alert alert--error", text: `Error al cargar: ${error.message}` }));
    return;
  }

  const n = (data || []).length;
  const total = count ?? n;
  const totalPaginas = Math.max(1, Math.ceil(total / PAGE));
  // Un filtro pudo dejar la página fuera de rango: se salta a la última.
  if (pagina > totalPaginas - 1 && irAPagina) return irAPagina(totalPaginas - 1);

  const desde = total ? pagina * PAGE + 1 : 0;
  const hasta = Math.min(total, (pagina + 1) * PAGE);
  const metaTexto = total
    ? (busca ? `${desde}–${hasta} de ${total} resultado(s) para “${busca}”` : `${desde}–${hasta} de ${total} registro(s) activos`)
    : (busca ? `Sin resultados para “${busca}”` : "Sin registros activos");
  const pie = () => el("div", { class: "list-foot" }, [
    el("p", { class: "list-meta", text: metaTexto }),
    buildPaginador(pagina, totalPaginas, irAPagina || (() => {})),
  ]);

  // Cuadrícula de tarjetas: la pestaña activa define `card(row, ctx)`.
  if (mostrarTarjetas && opcion?.card) {
    const editable = puedeEditar();
    const ctx = {
      rerender, editable,
      editar: (row) => openForm(config, row, rerender),
      desactivar: (row) => softDelete(config, row, rerender),
    };
    if (!n) {
      container.appendChild(el("div", { class: "card" }, [el("div", { class: "empty-state" }, [el("p", { text: "Sin registros." })])]));
    } else {
      const grid = el("div", { class: "card-grid" });
      for (const row of data) grid.appendChild(opcion.card(row, ctx));
      container.appendChild(grid);
    }
    container.appendChild(pie());
    return;
  }

  const columns = (opcion?.columns || config.columns).map((c) => ({
    ...c,
    render: c.render || (resolvers[c.key] ? (row) => resolvers[c.key](row[c.key]) : undefined),
  }));

  const editable = puedeEditar();
  // Sin acciones que mostrar (lector y sin acciones de solo lectura) no se
  // dibuja la columna "Acciones".
  const construirAcciones = (editable || config.rowActions)
    ? (row) => [
        ...(config.rowActions ? config.rowActions(row, rerender) : []),
        ...(editable ? [
          iconButton("Editar", "btn--ghost", () => openForm(config, row, rerender), "edit"),
          iconButton("Desactivar", "btn--danger-ghost", () => softDelete(config, row, rerender), "deactivate"),
        ] : []),
      ]
    : null;
  const table = buildTable(columns, data || [], construirAcciones);
  container.appendChild(table);
  container.appendChild(pie());
}

async function buildColumnResolvers(config) {
  const campos = (config.fields || []).filter((f) => f.source && f.type === "select");
  const mapas = await Promise.all(campos.map((f) => loadOptionsMap(f.source)));
  const resolvers = {};
  campos.forEach((field, i) => {
    const map = mapas[i];
    resolvers[field.name] = (id) => map.get(String(id)) || (id == null ? "—" : String(id));
  });
  return resolvers;
}

// Los catálogos de opciones (estados, unidades de medida, modelos de equipo…)
// cambian poco y se piden en cada re-render de la lista y en cada apertura de
// formulario. Un cache breve en memoria evita ese ir y venir repetido; se
// vacía en cuanto se guarda o desactiva algo, así nunca queda rancio.
const _opcionesCache = new Map();
const OPCIONES_TTL_MS = 60_000;

function _claveSource(source) {
  return JSON.stringify([
    source.table,
    source.value || "id",
    source.label || "nombre",
    source.filterActive !== false,
    source.labelFn ? source.labelFn.toString() : null,
  ]);
}

export function invalidarOpciones() {
  _opcionesCache.clear();
}

async function loadOptions(source) {
  const clave = _claveSource(source);
  const cacheado = _opcionesCache.get(clave);
  if (cacheado && Date.now() - cacheado.t < OPCIONES_TTL_MS) return cacheado.v;

  let q = supabase.from(source.table).select("*");
  if (source.filterActive !== false) q = q.eq("activo", true);
  q = q.order(source.label || "id", { ascending: true });
  const { data, error } = await q;
  if (error) throw error;
  const opciones = (data || []).map((r) => ({
    value: r[source.value || "id"],
    label: source.labelFn ? source.labelFn(r) : r[source.label || "nombre"],
  }));
  _opcionesCache.set(clave, { t: Date.now(), v: opciones });
  return opciones;
}

async function loadOptionsMap(source) {
  const opts = await loadOptions(source);
  return new Map(opts.map((o) => [String(o.value), o.label]));
}

async function openForm(config, record, rerender, segmentoDefault) {
  const isEdit = !!record;

  // Cargar opciones de campos select/multiselect, todas a la vez: en serie,
  // abrir el formulario esperaba un viaje a la base por cada campo con fuente.
  // `hideOnEdit`: el campo solo aparece al crear (p. ej. datos de identidad que
  // no deberían tocarse luego). Al editar ni se pinta ni entra en el payload,
  // así el valor guardado se conserva.
  const fields = await Promise.all(
    config.fields
      .filter((f) => !(isEdit && f.hideOnEdit))
      .map(async (f) => {
        const field = { ...f };
        if (f.source) field.options = await loadOptions(f.source);
        return field;
      })
  );

  // Datos relacionados (p.ej. equipos seleccionados de un producto)
  let related = {};
  if (config.hooks?.loadRelated && isEdit) {
    related = (await config.hooks.loadRelated(record)) || {};
  }

  // Rejilla de dos columnas: los campos cortos se emparejan y los largos
  // (texto multilínea, listas, interruptor, o `full: true`) ocupan la fila.
  const body = el("div", { class: "modal__body modal__body--grid" });
  const anchoCompleto = new Set(["textarea", "checklist", "checkbox", "multiselect"]);
  const inputs = {};
  const wraps = {};
  for (const field of fields) {
    // En alta, el campo que define la pestaña arranca con el valor de esa
    // pestaña; el resto usa su `default`.
    const esCampoDeSegmento = config.segments && field.name === config.segments.key;
    let value = isEdit
      ? (field.name in related ? related[field.name] : record[field.name])
      : (esCampoDeSegmento && segmentoDefault !== undefined ? segmentoDefault : field.default);
    // `parse` adapta lo guardado al control (p. ej. texto separado por comas
    // -> lista de opciones marcadas). `serialize` hace el camino inverso.
    if (typeof field.parse === "function") value = field.parse(value);
    const { wrap, input } = buildField(field, value);
    if (field.full || anchoCompleto.has(field.type)) wrap.classList.add("form-grid__full");

    // `scan: true` añade un botón de cámara junto al campo: al leer un código
    // de barras rellena el input igual que teclearlo (dispara input/change,
    // para que showIf y la validación se enteren). Si el navegador no puede
    // escanear, `botonEscanear` devuelve null y el campo queda como estaba.
    if (field.scan) {
      const btn = botonEscanear((codigo) => {
        input.value = codigo;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      if (btn) {
        const fila = el("div", { class: "field-scan" });
        wrap.replaceChild(fila, input);
        fila.append(input, btn);
      }
    }

    body.appendChild(wrap);
    inputs[field.name] = input;
    wraps[field.name] = wrap;
  }

  // Campos condicionales: `showIf(valores)` decide si el campo se muestra.
  // Un campo oculto no exige valor ni se guarda, para no dejar datos que la
  // pantalla no llegó a mostrar.
  const condicionales = fields.filter((f) => typeof f.showIf === "function");
  const valoresActuales = () =>
    Object.fromEntries(fields.map((f) => [f.name, readField(f, inputs[f.name])]));

  function aplicarCondicionales() {
    const vals = valoresActuales();
    for (const f of condicionales) {
      const visible = f.showIf(vals);
      wraps[f.name].hidden = !visible;
      inputs[f.name].required = visible && !!f.required;
    }
  }

  if (condicionales.length) {
    for (const f of fields) {
      inputs[f.name].addEventListener("change", aplicarCondicionales);
      inputs[f.name].addEventListener("input", aplicarCondicionales);
    }
    aplicarCondicionales();
  }

  openModal({
    title: config.formTitle || `${isEdit ? "Editar" : "Nuevo"} — ${config.singular || config.title}`,
    subtitle: config.formHint,
    body,
    submitLabel: config.submitLabel || (isEdit ? "Guardar cambios" : "Crear"),
    onSubmit: async (close) => {
      const payload = {};
      const extra = {}; // campos que no van directo a la tabla (multiselect con junction)
      for (const field of fields) {
        // Un campo oculto por showIf no se guarda: se limpia.
        const oculto = wraps[field.name].hidden;
        let val = oculto ? null : readField(field, inputs[field.name]);
        if (!oculto && typeof field.serialize === "function") val = field.serialize(val);
        if (field.junction) extra[field.name] = val;
        else payload[field.name] = val;
      }

      if (config.hooks?.beforeSave) config.hooks.beforeSave(payload, { isEdit, record });

      let saved;
      if (isEdit) {
        if ("updated_at" in record || config.touchUpdatedAt) payload.updated_at = new Date().toISOString();
        const { data, error } = await supabase
          .from(config.table).update(payload).eq("id", record.id).select().single();
        if (error) throw new Error(mensajeError(error));
        saved = data;
      } else {
        const { data, error } = await supabase
          .from(config.table).insert(payload).select().single();
        if (error) throw new Error(mensajeError(error));
        saved = data;
      }

      if (config.hooks?.afterSave) await config.hooks.afterSave(saved, extra, { isEdit });

      // Lo recién guardado puede ser opción de otro formulario (un estado, una
      // unidad…): que el cache no lo esconda hasta que caduque.
      invalidarOpciones();
      toast(isEdit ? "Registro actualizado." : "Registro creado.", "success");
      close();
      // Se pasa lo guardado por si quien abrió el formulario lo necesita (p. ej.
      // el buscador de Movimientos, que reabre la lista con el producto nuevo).
      rerender(saved);
    },
  });
}

async function softDelete(config, record, rerender) {
  const ok = await confirmDialog({
    title: "Desactivar registro",
    message: `¿Desactivar este registro de ${config.singular || config.title}? No se elimina; deja de mostrarse en la lista.`,
    confirmLabel: "Desactivar",
    danger: true,
  });
  if (!ok) return;
  const { error } = await supabase.from(config.table).update({ activo: false }).eq("id", record.id);
  if (error) {
    toast(`Error: ${error.message}`, "error");
    return;
  }
  invalidarOpciones();
  toast("Registro desactivado.", "success");
  rerender();
}

// Traduce los choques de unicidad de Postgres a algo accionable.
// Sin esto el usuario ve "duplicate key value violates unique constraint …".
const UNICIDAD = {
  uq_producto_unidad_no_serie: "Ya existe una unidad con ese número de serie. Cada unidad física lleva una serie distinta.",
  uq_producto_unidad_codigo_interno: "Ya existe una unidad con ese código interno.",
  uq_productos_no_parte_consumible: "Ya existe un producto con ese número de parte. Solo los componentes pueden repetirlo.",
  productos_codigo_barras_key: "Ya existe un producto con ese código de barras.",
  unidades_medida_codigo_key: "Ya existe una unidad de medida con ese código.",
  uq_producto_almacen_trazable: "Ese componente ya tiene existencia registrada; no puede duplicarse.",
  uq_producto_almacen_grano: "Ya existe una existencia con ese estado y esa ubicación.",
  uq_euo_codigo_asignado_vigente: "Otro equipo ya tiene ese código asignado en ese establecimiento.",
  uq_euo_asignacion_abierta: "Ese equipo ya tiene una asignación vigente. Ciérrala con una fecha de fin antes de reasignarlo.",
  uq_unidad_operativa_codigo: "Ya existe un establecimiento con ese código.",
  uq_equipos_codigo: "Ya existe un equipo con ese código.",
  uq_proveedores_codigo: "Ya existe un proveedor con ese código.",
  uq_proveedores_ruc: "Ya existe un proveedor con ese RUC.",
  ck_euo_fechas: "La fecha de fin no puede ser anterior a la de inicio.",
  ck_euo_horometros: "El horómetro final no puede ser menor que el inicial, y no se admiten valores negativos.",
};

export function mensajeError(error) {
  const texto = `${error?.message || ""} ${error?.details || ""}`;
  for (const [clave, mensaje] of Object.entries(UNICIDAD)) {
    if (texto.includes(clave)) return mensaje;
  }
  return error?.message || "No se pudo guardar.";
}

// Reexport para vistas a medida: `loadOptions` (filtros) y el formulario /
// borrado estándar, para no duplicar el CRUD en vistas con diseño propio.
export { loadOptions, openForm, softDelete };
