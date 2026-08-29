import { supabase } from "./supabaseClient.js";
import {
  el, clear, toast, openModal, confirmDialog,
  buildField, readField, buildTable, iconButton,
} from "./ui.js";

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
// `search` (opcional) añade una caja de búsqueda con filtro en varias
// columnas a la vez: { placeholder, fields: [...] } (`.ilike` sobre cada
// campo, combinados con OR). Una opción de `segments` puede declarar su
// propio `searchFields` cuando su tabla tiene columnas distintas a las del
// resto (p. ej. una vista con más campos que la tabla base).
//
// La búsqueda solo refresca la lista, no toda la pantalla: si se
// reconstruyera la página completa en cada tecleo, el propio campo de texto
// se recrearía y el usuario perdería el foco mientras escribe.
export function createCrudView(config) {
  let segmentoActivo = config.segments?.options?.[0]?.value;
  let termino = "";

  return {
    async render(root) {
      clear(root);
      // Al crear desde una pestaña, el registro nace con ese tipo: pulsar
      // "Nuevo" en Trazables no debería dar de alta un consumible.
      root.appendChild(
        buildHeader(config, () => openForm(config, null, () => this.render(root), segmentoActivo))
      );

      if (config.segments) {
        root.appendChild(
          buildSegments(config.segments, segmentoActivo, (valor) => {
            segmentoActivo = valor;
            this.render(root);
          })
        );
      }

      const opcion = config.segments?.options?.find((o) => o.value === segmentoActivo);
      const camposBusqueda = opcion?.searchFields || config.search?.fields;

      const listContainer = el("div", { class: "card" }, [el("div", { class: "loading", text: "Cargando…" })]);
      const cargarLista = () =>
        refreshList(config, listContainer, () => this.render(root), segmentoActivo, opcion, termino, camposBusqueda);

      if (config.search && camposBusqueda?.length) {
        root.appendChild(
          buildSearchBar(config.search, termino, (valor) => {
            termino = valor;
            cargarLista();
          })
        );
      }

      root.appendChild(listContainer);
      await cargarLista();
    },
  };
}

function buildSearchBar(search, valor, onChange) {
  const input = el("input", {
    id: "f-busqueda", class: "input", type: "search", value: valor,
    placeholder: search.placeholder || "Buscar…",
    autocomplete: "off", spellcheck: "false",
    oninput: debounce((e) => onChange(e.target.value)),
  });
  return el("div", { class: "filters" }, [
    el("div", { class: "filter filter--primary" }, [
      el("label", { class: "filter-label", for: "f-busqueda", text: "Buscar" }),
      input,
    ]),
  ]);
}

function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function buildSegments(segments, activo, onChange) {
  const grupo = el("div", {
    class: "segments", role: "tablist",
    "aria-label": segments.label || "Filtrar lista",
  });
  for (const opt of segments.options) {
    const seleccionado = opt.value === activo;
    grupo.appendChild(
      el("button", {
        type: "button", class: `segments__btn${seleccionado ? " segments__btn--on" : ""}`,
        role: "tab", "aria-selected": seleccionado ? "true" : "false",
        onclick: () => { if (!seleccionado) onChange(opt.value); },
      }, [
        el("span", { text: opt.label }),
        opt.hint ? el("span", { class: "segments__hint", text: opt.hint }) : null,
      ])
    );
  }
  return grupo;
}

function buildHeader(config, onNew) {
  return el("div", { class: "page-header" }, [
    el("div", {}, [
      el("h2", { class: "page-title", text: config.title }),
      el("p", { class: "page-subtitle", text: `Mantenimiento de ${config.singular || config.title.toLowerCase()}.` }),
    ]),
    el("button", { class: "btn btn--primary", text: "+ Nuevo", onclick: onNew }),
  ]);
}

async function refreshList(config, container, rerender, segmentoActivo, opcion, termino, camposBusqueda) {
  clear(container);
  // La pestaña puede leer de una vista distinta (con datos unidos); las
  // escrituras siguen yendo a config.table.
  let query = supabase
    .from(opcion?.table || config.table)
    .select("*")
    .eq("activo", true)
    .order(config.orderBy || "id", { ascending: true });

  if (config.segments && segmentoActivo !== undefined) {
    query = query.eq(config.segments.key, segmentoActivo);
  }
  if (termino && camposBusqueda?.length) {
    // La sintaxis de .or() usa comas y paréntesis como separadores.
    const seguro = termino.replace(/[,()%]/g, " ").trim();
    if (seguro) query = query.or(camposBusqueda.map((f) => `${f}.ilike.%${seguro}%`).join(","));
  }

  const columns = opcion?.columns || config.columns;

  // La consulta principal y las de resolución de columnas son independientes:
  // van en paralelo en vez de una tras otra.
  const [{ data, error }, resolvers] = await Promise.all([
    query,
    buildColumnResolvers(config, columns),
  ]);
  if (error) {
    container.appendChild(el("div", { class: "alert alert--error", text: `Error al cargar: ${error.message}` }));
    return;
  }

  const columnasConRender = columns.map((c) => ({
    ...c,
    render: c.render || (resolvers[c.key] ? (row) => resolvers[c.key](row[c.key]) : undefined),
  }));

  const table = buildTable(columnasConRender, data || [], (row) => [
    ...(config.rowActions ? config.rowActions(row, rerender) : []),
    iconButton("Editar", "btn--ghost", () => openForm(config, row, rerender)),
    iconButton("Desactivar", "btn--danger-ghost", () => softDelete(config, row, rerender)),
  ]);
  container.appendChild(table);
  container.appendChild(el("div", { class: "list-meta", text: `${(data || []).length} registro(s) activos.` }));
}

// Solo resuelve los campos `select` que de verdad aparecen como columna en
// la lista visible: pedir el catálogo completo de un campo que ni se
// muestra (p. ej. "estado" cuando la pestaña activa no lo lista) es una
// consulta desperdiciada en cada render.
async function buildColumnResolvers(config, columns) {
  const claves = new Set(columns.map((c) => c.key));
  const fuentes = (config.fields || []).filter(
    (f) => f.source && f.type === "select" && claves.has(f.name)
  );
  const entradas = await Promise.all(
    fuentes.map(async (f) => [f.name, await loadOptionsMap(f.source)])
  );
  const resolvers = {};
  for (const [nombre, mapa] of entradas) {
    resolvers[nombre] = (id) => mapa.get(String(id)) || (id == null ? "—" : String(id));
  }
  return resolvers;
}

async function loadOptions(source) {
  let q = supabase.from(source.table).select("*");
  if (source.filterActive !== false) q = q.eq("activo", true);
  q = q.order(source.label || "id", { ascending: true });
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map((r) => ({
    value: r[source.value || "id"],
    label: source.labelFn ? source.labelFn(r) : r[source.label || "nombre"],
  }));
}

async function loadOptionsMap(source) {
  const opts = await loadOptions(source);
  return new Map(opts.map((o) => [String(o.value), o.label]));
}

async function openForm(config, record, rerender, segmentoDefault) {
  const isEdit = !!record;

  // Cargar opciones de campos select/multiselect: en paralelo, no una tras
  // otra. Promise.all conserva el orden del arreglo aunque las respuestas
  // lleguen en otro orden.
  const fields = await Promise.all(
    config.fields.map(async (f) => {
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

  const body = el("div", { class: "modal__body" });
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
    title: `${isEdit ? "Editar" : "Nuevo"} — ${config.singular || config.title}`,
    body,
    submitLabel: isEdit ? "Guardar cambios" : "Crear",
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

      toast(isEdit ? "Registro actualizado." : "Registro creado.", "success");
      close();
      rerender();
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
  toast("Registro desactivado.", "success");
  rerender();
}

// Traduce los choques de unicidad de Postgres a algo accionable.
// Sin esto el usuario ve "duplicate key value violates unique constraint …".
const UNICIDAD = {
  uq_producto_unidad_no_serie: "Ya existe una unidad con ese número de serie. Cada unidad física lleva una serie distinta.",
  uq_producto_unidad_codigo_interno: "Ya existe una unidad con ese código interno.",
  uq_productos_no_parte_consumible: "Ya existe un producto con ese número de parte. Solo los trazables pueden repetirlo.",
  productos_codigo_barras_key: "Ya existe un producto con ese código de barras.",
  unidades_medida_codigo_key: "Ya existe una unidad de medida con ese código.",
  uq_producto_almacen_trazable: "Ese artículo trazable ya tiene existencia registrada; no puede duplicarse.",
  uq_producto_almacen_grano: "Ya existe una existencia con ese estado y esa ubicación.",
  uq_euo_codigo_asignado_vigente: "Otro equipo ya tiene ese código asignado en esa unidad operativa.",
  uq_euo_asignacion_abierta: "Ese equipo ya tiene una asignación vigente. Ciérrala con una fecha de fin antes de reasignarlo.",
  uq_unidad_operativa_codigo: "Ya existe una unidad operativa con ese código.",
  uq_equipos_codigo: "Ya existe un equipo con ese código.",
  ck_euo_fechas: "La fecha de fin no puede ser anterior a la de inicio.",
  uq_proveedores_codigo: "Ya existe un proveedor con ese código.",
  uq_proveedores_ruc: "Ya existe un proveedor con ese RUC.",
};

export function mensajeError(error) {
  const texto = `${error?.message || ""} ${error?.details || ""}`;
  for (const [clave, mensaje] of Object.entries(UNICIDAD)) {
    if (texto.includes(clave)) return mensaje;
  }
  return error?.message || "No se pudo guardar.";
}

// Reexport util para vistas que necesiten cargar opciones (filtros)
export { loadOptions };
