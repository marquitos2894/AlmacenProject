// Bitácora — SOLO CONSULTA. La llenan los triggers de la base (fn_log_evento):
// quién hizo qué y cuándo, con una reseña y los datos cambiados.
import { supabase } from "../supabaseClient.js";
import { el, clear, openModal, buildTable, iconButton, buildPaginador } from "../ui.js";

const PAGE = 50;
const filtros = { usuario_id: "", desde: "", hasta: "", q: "" };

const BADGE = {
  alta: "in", reactivación: "in", edición: "info",
  baja: "out", anulación: "out", eliminación: "out",
};

export default {
  async render(root) {
    clear(root);
    root.appendChild(
      el("div", { class: "page-header" }, [
        el("div", {}, [
          el("h2", { class: "page-title", text: "Bitácora" }),
          el("p", { class: "page-subtitle", text: "Registro de eventos: quién hizo qué y cuándo." }),
        ]),
      ])
    );

    const { data: usuarios } = await supabase.from("usuarios").select("id, nombre, email").order("nombre");
    const lista = el("div", { class: "card" });
    let pagina = 0;
    root.appendChild(buildFiltros(usuarios || [], () => { pagina = 0; cargar(); }));
    root.appendChild(lista);
    await cargar();

    async function cargar() {
      clear(lista);
      lista.appendChild(el("p", { class: "loading", text: "Cargando…" }));

      let q = supabase.from("log_eventos").select("*", { count: "exact" });
      if (filtros.usuario_id) q = q.eq("usuario_id", filtros.usuario_id);
      if (filtros.desde) q = q.gte("created_at", new Date(`${filtros.desde}T00:00:00`).toISOString());
      if (filtros.hasta) q = q.lt("created_at", new Date(new Date(`${filtros.hasta}T00:00:00`).getTime() + 864e5).toISOString());
      const safe = filtros.q.replace(/[,()*%]/g, " ").trim();
      if (safe) q = q.ilike("resena", `%${safe}%`);
      q = q.order("id", { ascending: false }).range(pagina * PAGE, pagina * PAGE + PAGE - 1);

      const { data, error, count } = await q;
      clear(lista);
      if (error) {
        lista.appendChild(el("div", { class: "alert alert--error", text: `No se pudo cargar la bitácora: ${error.message}` }));
        return;
      }

      const total = count ?? (data || []).length;
      const totalPaginas = Math.max(1, Math.ceil(total / PAGE));
      if (pagina > totalPaginas - 1) { pagina = totalPaginas - 1; return cargar(); }

      const columnas = [
        { key: "created_at", label: "Fecha", render: (r) => el("span", { class: "mono", text: fechaHora(r.created_at) }) },
        { key: "usuario", label: "Usuario", render: (r) => r.usuario || "Sistema" },
        { key: "accion", label: "Acción", render: (r) => el("span", { class: `badge badge--${BADGE[r.accion] || "muted"}`, text: r.accion }) },
        { key: "entidad", label: "Entidad" },
        { key: "resena", label: "Reseña" },
      ];
      lista.appendChild(
        buildTable(columnas, data || [], (row) => [
          iconButton("Ver detalle", "btn--ghost", () => verDetalle(row), "search"),
        ])
      );

      const desdeN = total ? pagina * PAGE + 1 : 0;
      const hastaN = Math.min(total, (pagina + 1) * PAGE);
      lista.appendChild(
        el("div", { class: "list-foot" }, [
          el("p", { class: "list-meta", text: total ? `${desdeN}–${hastaN} de ${total} evento(s)` : "0 eventos" }),
          buildPaginador(pagina, totalPaginas, (p) => { pagina = p; cargar(); }),
        ])
      );
    }
  },
};

function buildFiltros(usuarios, onChange) {
  const usuario = el("select", {
    class: "input", id: "f-usuario",
    onchange: (e) => { filtros.usuario_id = e.target.value; onChange(); },
  }, [
    el("option", { value: "", text: "Todos los usuarios" }),
    ...usuarios.map((u) => {
      const o = el("option", { value: String(u.id), text: u.nombre || u.email });
      if (String(u.id) === String(filtros.usuario_id)) o.selected = true;
      return o;
    }),
  ]);
  const fecha = (id, clave) => el("input", {
    class: "input", type: "date", id, value: filtros[clave],
    onchange: (e) => { filtros[clave] = e.target.value; onChange(); },
  });
  const busca = el("input", {
    class: "input", type: "search", id: "f-busca", value: filtros.q,
    placeholder: "Folio, producto, motivo…", autocomplete: "off",
    oninput: debounce((e) => { filtros.q = e.target.value; onChange(); }),
  });

  const celda = (id, label, control) => el("div", { class: "filter" }, [
    el("label", { class: "filter-label", for: id, text: label }), control,
  ]);
  return el("div", { class: "filters" }, [
    celda("f-usuario", "Usuario", usuario),
    celda("f-desde", "Desde", fecha("f-desde", "desde")),
    celda("f-hasta", "Hasta", fecha("f-hasta", "hasta")),
    celda("f-busca", "Buscar en la reseña", busca),
  ]);
}

function verDetalle(ev) {
  const cambios = ev.cambios || {};
  const esEdicion = ev.operacion === "UPDATE";
  const filas = Object.entries(cambios).map(([campo, v]) =>
    esEdicion ? { campo, antes: v?.[0], despues: v?.[1] } : { campo, valor: v }
  );
  const columnas = esEdicion
    ? [
        { key: "campo", label: "Campo" },
        { key: "antes", label: "Antes", render: (r) => valor(r.antes) },
        { key: "despues", label: "Después", render: (r) => valor(r.despues) },
      ]
    : [
        { key: "campo", label: "Campo" },
        { key: "valor", label: "Valor", render: (r) => valor(r.valor) },
      ];

  openModal({
    title: `${ev.entidad} — ${ev.accion}`,
    subtitle: `${fechaHora(ev.created_at)} · ${ev.usuario || "Sistema"}`,
    body: el("div", { class: "modal__body" }, [
      el("p", { text: ev.resena }),
      buildTable(columnas, filas, null),
    ]),
    submitLabel: "Cerrar",
    readOnly: true,
    size: "wide",
    onSubmit: async (cerrar) => cerrar(),
  });
}

function valor(v) {
  if (v == null || v === "") return "—";
  return el("span", { class: "mono", text: typeof v === "object" ? JSON.stringify(v) : String(v) });
}

function fechaHora(ts) {
  return ts ? new Date(ts).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" }) : "—";
}

function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
