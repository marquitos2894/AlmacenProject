import { supabase, isConfigured } from "./supabaseClient.js";
import { getSession, signIn, signOut, ensureUsuario, onAuthChange } from "./auth.js";
import { el, clear, toast } from "./ui.js";

import unidadesMedida from "./views/unidadesMedida.js";
import estados from "./views/estados.js";
import equipos from "./views/equipos.js";
import almacenes from "./views/almacenes.js";
import productos from "./views/productos.js";
import productoAlmacen from "./views/productoAlmacen.js";
import movimientos from "./views/movimientos.js";
import unidadesOperativas from "./views/unidadesOperativas.js";
import equipoUnidadOperativa from "./views/equipoUnidadOperativa.js";

const NAV = [
  {
    group: "Inventario",
    items: [
      { id: "productos", label: "Productos", icon: "📦", view: productos },
      { id: "stock", label: "Stock por almacén", icon: "🏬", view: productoAlmacen },

      { id: "movimientos", label: "Movimientos", icon: "🔁", view: movimientos },
    ],
  },
  {
    group: "Catálogos",
    items: [
      { id: "almacenes", label: "Almacenes", icon: "🏢", view: almacenes },
      { id: "unidades", label: "Unidades de medida", icon: "📏", view: unidadesMedida },
      { id: "estados", label: "Estados", icon: "🏷️", view: estados },
      { id: "equipos", label: "Equipos", icon: "⚙️", view: equipos },
    ],
  },
  {
    group: "Operaciones",
    items: [
      { id: "unidades-operativas", label: "Unidades operativas", icon: "⛏️", view: unidadesOperativas },
      { id: "equipos-unidad", label: "Equipos por unidad", icon: "🔗", view: equipoUnidadOperativa },
    ],
  },
];

const ROUTES = Object.fromEntries(NAV.flatMap((g) => g.items).map((i) => [i.id, i]));
const DEFAULT_ROUTE = "productos";

const appRoot = document.getElementById("app");

// El listener de navegación vive fuera de renderApp para no duplicarse.
let hashListenerPuesto = false;

// ------------------------------------------------------------- Arranque
init();

async function init() {
  if (!isConfigured()) {
    renderConfigWarning();
    return;
  }

  // Qué usuario está pintado ahora mismo. supabase-js emite eventos de auth
  // también al volver a la pestaña (revalida y refresca el token): sin este
  // control, cada regreso repintaba la app entera y se perdía lo que el
  // usuario estuviera capturando.
  let usuarioPintado = null;

  onAuthChange(async (session) => {
    const uid = session?.user?.id ?? null;
    if (uid === usuarioPintado) return; // mismo usuario: no hay nada que repintar

    usuarioPintado = uid;
    if (session) {
      await ensureUsuario(session.user);
      renderApp(session);
    } else {
      renderLogin();
    }
  });

  const session = await getSession();
  usuarioPintado = session?.user?.id ?? null;
  if (session) {
    await ensureUsuario(session.user);
    renderApp(session);
  } else {
    renderLogin();
  }
}

// ------------------------------------------------------------- Login
function renderLogin() {
  clear(appRoot);
  const email = el("input", { class: "input", type: "email", placeholder: "correo@empresa.com", required: "required", autocomplete: "username" });
  const pass = el("input", { class: "input", type: "password", placeholder: "Contraseña", required: "required", autocomplete: "current-password" });
  const btn = el("button", { class: "btn btn--primary btn--block", type: "submit", text: "Ingresar" });

  const form = el("form", { class: "login-form" }, [
    el("div", { class: "form-row" }, [el("label", { class: "form-label", text: "Correo" }), email]),
    el("div", { class: "form-row" }, [el("label", { class: "form-label", text: "Contraseña" }), pass]),
    btn,
  ]);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = "Ingresando…";
    try {
      await signIn(email.value.trim(), pass.value);
      // onAuthChange se encarga de renderApp
    } catch (err) {
      toast(err.message || "No se pudo iniciar sesión", "error");
      btn.disabled = false;
      btn.textContent = "Ingresar";
    }
  });

  appRoot.appendChild(
    el("div", { class: "login-screen" }, [
      el("div", { class: "login-card" }, [
        el("div", { class: "login-brand" }, [el("span", { class: "login-logo", text: "📦" }), el("h1", { text: "Gestión de Almacén" })]),
        el("p", { class: "login-sub", text: "Inicia sesión para continuar." }),
        form,
      ]),
    ])
  );
}

// ------------------------------------------------------------- App shell
function renderApp(session) {
  clear(appRoot);

  const content = el("main", { class: "content", id: "content", tabindex: "-1" });

  const sidebar = el("aside", { class: "sidebar" }, [
    el("div", { class: "sidebar__brand" }, [el("span", { class: "sidebar__logo", text: "📦" }), el("span", { class: "sidebar__title", text: "Almacén" })]),
    el("nav", { class: "nav" }, NAV.map(buildNavGroup)),
  ]);

  const topbar = el("header", { class: "topbar" }, [
    el("button", {
      class: "topbar__menu", type: "button", text: "☰",
      "aria-label": "Abrir menú de navegación",
      onclick: () => document.body.classList.toggle("sidebar-open"),
    }),
    el("div", { class: "topbar__title", id: "page-title", text: "" }),
    el("div", { class: "topbar__user" }, [
      el("span", { class: "topbar__email", text: session.user.email }),
      el("button", { class: "btn btn--ghost btn--sm", text: "Salir", onclick: async () => { await signOut(); location.hash = ""; } }),
    ]),
  ]);

  // El href no navega: cambiar el hash rompería el router, así que se
  // enfoca el contenido directamente.
  appRoot.appendChild(
    el("a", {
      class: "skip-link", href: "#content", text: "Saltar al contenido",
      onclick: (e) => { e.preventDefault(); content.focus(); },
    })
  );
  appRoot.appendChild(
    el("div", { class: "layout" }, [
      sidebar,
      el("div", { class: "main" }, [topbar, content]),
    ])
  );

  // Se registra una sola vez en toda la vida de la página: `renderApp` puede
  // volver a ejecutarse (p. ej. al cambiar de usuario) y cada registro extra
  // haría que `route()` corriera N veces por cada navegación.
  if (!hashListenerPuesto) {
    window.addEventListener("hashchange", route);
    hashListenerPuesto = true;
  }
  route();
}

function buildNavGroup(group) {
  return el("div", { class: "nav__group" }, [
    el("div", { class: "nav__group-label", text: group.group }),
    ...group.items.map((item) =>
      el("a", { class: "nav__item", href: `#/${item.id}`, dataset: { route: item.id } }, [
        el("span", { class: "nav__icon", "aria-hidden": "true", text: item.icon }),
        el("span", { text: item.label }),
      ])
    ),
  ]);
}

async function route() {
  // #/movimientos/3/nuevo -> id "movimientos", params ["3", "nuevo"]
  const segments = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const id = segments[0] || DEFAULT_ROUTE;
  const params = segments.slice(1);
  const entry = ROUTES[id] || ROUTES[DEFAULT_ROUTE];

  document.querySelectorAll(".nav__item").forEach((a) =>
    a.classList.toggle("nav__item--active", a.dataset.route === entry.id)
  );
  const titleEl = document.getElementById("page-title");
  if (titleEl) titleEl.textContent = entry.label;
  document.body.classList.remove("sidebar-open");

  const content = document.getElementById("content");
  clear(content);
  content.appendChild(el("p", { class: "loading", text: "Cargando…" }));
  try {
    await entry.view.render(content, params);
  } catch (err) {
    clear(content);
    content.appendChild(el("div", { class: "alert alert--error", text: `No se pudo cargar la vista: ${err.message}` }));
    console.error(err);
  }
}

// ------------------------------------------------------------- Config warning
function renderConfigWarning() {
  clear(appRoot);
  appRoot.appendChild(
    el("div", { class: "login-screen" }, [
      el("div", { class: "login-card" }, [
        el("h1", { text: "Configuración requerida" }),
        el("p", { class: "login-sub", text: "Edita public/js/config.js con la URL y la clave anon de tu proyecto Supabase, y recarga la página." }),
      ]),
    ])
  );
}
