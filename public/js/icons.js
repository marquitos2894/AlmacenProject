// Iconos de trazo, un solo estilo (viewBox 24, stroke = currentColor, remates
// redondeados). Devuelven una cadena SVG para insertarla con { html: … }.
// Reemplazan a los emoji de la navegación y de las acciones de tabla.

const PATHS = {
  // -- Navegación
  dashboard: '<rect x="3" y="3" width="8" height="9" rx="1.6"/><rect x="13" y="3" width="8" height="5" rx="1.6"/><rect x="13" y="12" width="8" height="9" rx="1.6"/><rect x="3" y="16" width="8" height="5" rx="1.6"/>',
  productos: '<path d="M12 3 3 7.5V16.5L12 21l9-4.5v-9L12 3Z"/><path d="M3 7.5 12 12l9-4.5"/><path d="M12 12v9"/>',
  stock: '<path d="M12 3 2 8l10 5 10-5-10-5Z"/><path d="m2 12 10 5 10-5"/><path d="m2 16 10 5 10-5"/>',
  movimientos: '<path d="M7 4 3 8l4 4"/><path d="M3 8h13"/><path d="m17 20 4-4-4-4"/><path d="M21 16H8"/>',
  transferencias: '<rect x="2" y="4" width="8" height="7" rx="1.4"/><rect x="14" y="13" width="8" height="7" rx="1.4"/><path d="M10 7h6.5M16.5 7 14 4.5M16.5 7 14 9.5"/><path d="M14 16.5H7.5M7.5 16.5 10 14M7.5 16.5 10 19"/>',
  almacenes: '<rect x="4" y="3" width="16" height="18" rx="1.6"/><path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M9 16h6"/>',
  proveedores: '<path d="M3 6h11v9H3z"/><path d="M14 9h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.7"/><circle cx="17" cy="18" r="1.7"/>',
  unidades: '<path d="M4 16 16 4l4 4L8 20z"/><path d="m9 9 1.4 1.4M12 6l1.4 1.4M6 12l1.4 1.4"/>',
  estados: '<path d="M4 12V5a1 1 0 0 1 1-1h7l8 8-8 8-8-8Z"/><circle cx="8.5" cy="8.5" r="1.4"/>',
  equipos: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3.5v3M12 17.5v3M5.5 5.5l2 2M16.5 16.5l2 2M3.5 12h3M17.5 12h3M5.5 18.5l2-2M16.5 7.5l2-2"/>',
  "unidades-operativas": '<path d="M4 15a8 8 0 0 1 16 0"/><path d="M10 8V5h4v3"/><path d="M3 15h18v3H3z"/>',
  "equipos-unidad": '<path d="M9 12h6"/><path d="M9 12a3 3 0 0 0-3-3H5a3 3 0 0 0 0 6h1a3 3 0 0 0 3-3Z"/><path d="M15 12a3 3 0 0 1 3-3h1a3 3 0 0 1 0 6h-1a3 3 0 0 1-3-3Z"/>',

  // -- Interfaz
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  "chevron-left": '<path d="m14 6-6 6 6 6"/>',
  logout: '<path d="M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M10 8 6 12l4 4"/><path d="M6 12h11"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m14 6 4 4"/>',
  print: '<path d="M7 9V3h10v6"/><path d="M7 18H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><rect x="7" y="14" width="10" height="7"/>',
  deactivate: '<path d="M12 4v8"/><path d="M6.5 7a7 7 0 1 0 11 0"/>',
  history: '<path d="M3 12a9 9 0 1 0 4-7.5"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.4-3.4"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M4 12h16"/>',
  wrench: '<path d="M15.4 5.4a4.5 4.5 0 0 0-5.9 5.9l-5 5a1.6 1.6 0 0 0 2.3 2.3l5-5a4.5 4.5 0 0 0 5.9-5.9l-2.5 2.5-2.1-.4-.4-2.1 2.7-2.8Z"/>',
  ticket: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/>',
  grid: '<rect x="3" y="3" width="8" height="8" rx="1.6"/><rect x="13" y="3" width="8" height="8" rx="1.6"/><rect x="3" y="13" width="8" height="8" rx="1.6"/><rect x="13" y="13" width="8" height="8" rx="1.6"/>',
};

export function icon(name, { size = 20, stroke = 1.75 } = {}) {
  const body = PATHS[name] || "";
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

// Marca del producto para el logotipo de la barra lateral.
export const LOGO_MARK = icon("productos", { size: 21, stroke: 1.8 });
