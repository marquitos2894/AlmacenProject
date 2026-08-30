import { supabase, isConfigured } from "./supabaseClient.js";
import { getSession, signIn, signOut, ensureUsuario, onAuthChange, puedeEditar } from "./auth.js";
import { el, clear, toast } from "./ui.js";
import { icon } from "./icons.js";

import dashboard from "./views/dashboard.js";
import unidadesMedida from "./views/unidadesMedida.js";
import estados from "./views/estados.js";
import equipos from "./views/equipos.js";
import almacenes from "./views/almacenes.js";
import productos from "./views/productos.js";
import productoAlmacen from "./views/productoAlmacen.js";
import movimientos from "./views/movimientos.js";
import transferencias from "./views/transferencias.js";
import proveedores from "./views/proveedores.js";
import unidadesOperativas from "./views/unidadesOperativas.js";

const NAV = [
  {
    group: "General",
    items: [
      { id: "dashboard", label: "Panel", view: dashboard },
    ],
  },
  {
    group: "Inventario",
    items: [
      { id: "productos", label: "Productos", icon: "📦", view: productos },
      { id: "stock", label: "Stock por almacén", icon: "🏬", view: productoAlmacen },

      { id: "movimientos", label: "Movimientos", icon: "🔁", view: movimientos },
      { id: "transferencias", label: "Transferencias", icon: "🔀", view: transferencias },
    ],
  },
  {
    group: "Catálogos",
    items: [
      { id: "almacenes", label: "Almacenes", icon: "🏢", view: almacenes },
      { id: "proveedores", label: "Proveedores", icon: "🚚", view: proveedores },
      { id: "unidades", label: "Unidades de medida", icon: "📏", view: unidadesMedida },
      { id: "estados", label: "Estados", icon: "🏷️", view: estados },
      { id: "equipos", label: "Equipos", icon: "⚙️", view: equipos },
    ],
  },
  {
    group: "Operaciones",
    items: [
      { id: "unidades-operativas", label: "Unidades operativas", icon: "⛏️", view: unidadesOperativas },
    ],
  },
];

const ROUTES = Object.fromEntries(NAV.flatMap((g) => g.items).map((i) => [i.id, i]));
const DEFAULT_ROUTE = "dashboard";
const LOGO_EMPRESA = "img/logo/corimayologo.png";

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
        el("div", { class: "login-brand" }, [
          el("img", { class: "login-logo", src: LOGO_EMPRESA, alt: "Corimayo" }),
          el("h1", { text: "Gestión de Almacén" }),
        ]),
        el("p", { class: "login-sub", text: "Inicia sesión para continuar." }),
        form,
      ]),
    ])
  );
}

// ------------------------------------------------------------- App shell
function renderApp(session) {
  clear(appRoot);

  // Restaura la preferencia de barra lateral colapsada (solo aplica en escritorio).
  try {
    document.body.classList.toggle("sidebar-collapsed", localStorage.getItem("sidebar-collapsed") === "1");
  } catch {}

  const content = el("main", { class: "content", id: "content", tabindex: "-1" });

  // En móvil (barra fuera de pantalla) el botón la despliega; en escritorio la
  // colapsa y recuerda la preferencia. Lo comparten el botón de la topbar y el
  // chevron del encabezado de la barra lateral.
  const toggleSidebar = () => {
    if (window.matchMedia("(max-width: 860px)").matches) {
      document.body.classList.toggle("sidebar-open");
    } else {
      const colapsada = document.body.classList.toggle("sidebar-collapsed");
      try { localStorage.setItem("sidebar-collapsed", colapsada ? "1" : "0"); } catch {}
    }
  };

  const cerrarSesion = async () => { await signOut(); location.hash = ""; };
  const iniciales = (session.user.email || "?").slice(0, 2).toUpperCase();

  const sidebar = el("aside", { class: "sidebar" }, [
    el("div", { class: "sidebar__brand" }, [
      el("span", { class: "sidebar__logo" }, [
        el("img", { src: LOGO_EMPRESA, alt: "Corimayo" }),
      ]),
      el("span", { class: "sidebar__brand-text" }, [
        el("span", { class: "sidebar__title", text: "Almacén TCH" }),
        el("span", { class: "sidebar__subtitle", text: "Gestión de inventario" }),
      ]),
      el("button", {
        class: "sidebar__collapse", type: "button",
        "aria-label": "Ocultar o mostrar el menú",
        html: icon("chevron-left", { size: 16, stroke: 2 }),
        onclick: toggleSidebar,
      }),
    ]),
    el("nav", { class: "nav" }, NAV.map(buildNavGroup)),
    el("div", { class: "sidebar__user" }, [
      el("span", { class: "sidebar__avatar", text: iniciales }),
      el("span", { class: "sidebar__user-info" }, [
        el("span", { class: "sidebar__user-name", text: session.user.email }),
        puedeEditar() ? null : el("span", { class: "sidebar__role", text: "Solo lectura" }),
      ]),
      el("button", {
        class: "sidebar__logout", type: "button", text: "Salir",
        "aria-label": "Cerrar sesión",
        onclick: cerrarSesion,
      }),
    ]),
  ]);

  const topbar = el("header", { class: "topbar" }, [
    el("button", {
      class: "topbar__menu", type: "button",
      "aria-label": "Mostrar u ocultar el menú de navegación",
      html: icon("menu", { size: 18, stroke: 1.9 }),
      onclick: toggleSidebar,
    }),
    el("div", { class: "topbar__title", id: "page-title", text: "" }),
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
        el("span", { class: "nav__icon", "aria-hidden": "true", html: icon(item.id, { size: 19 }) }),
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
