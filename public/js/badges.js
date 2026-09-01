// Insignia de estado con color según su significado. `estados` es un catálogo
// editable, así que se mapea por nombre conocido y hay un color neutro de
// reserva para cualquier estado nuevo.
import { el } from "./ui.js";

const MAPA = {
  // verde — todo bien
  disponible: "in", operativo: "in", nuevo: "in", bueno: "in", activo: "in",
  "en servicio": "in", "en stock": "in",
  // índigo — en circulación
  "en uso": "info", asignado: "info", operando: "info", prestado: "info",
  "en transito": "info", "en tránsito": "info", "en obra": "info",
  // ámbar — requiere atención
  "en reparacion": "warn", "en reparación": "warn", reparacion: "warn", "reparación": "warn",
  mantenimiento: "warn", observado: "warn", pendiente: "warn", cuarentena: "warn", revision: "warn", "revisión": "warn",
  // rojo — inservible
  "dañado": "out", danado: "out", malogrado: "out", inservible: "out",
  "fuera de servicio": "out", siniestrado: "out", perdido: "out",
  // gris — retirado
  baja: "muted", "de baja": "muted", retirado: "muted", chatarra: "muted",
  descarte: "muted", inactivo: "muted", obsoleto: "muted",
};

export function badgeEstado(nombre) {
  if (!nombre || !String(nombre).trim()) return el("span", { class: "ref__vacio", text: "—" });
  const variante = MAPA[String(nombre).trim().toLowerCase()] || "estado";
  return el("span", { class: `badge badge--${variante}`, text: nombre });
}

// Insignia de existencias: rojo cuando no hay stock (0 o menos), verde cuando
// lo hay. `prefijo` antepone un texto opcional, p. ej. "Stock: ".
export function badgeStock(cantidad, { prefijo = "" } = {}) {
  const n = Number(cantidad);
  const valor = Number.isFinite(n) ? n : 0;
  return el("span", {
    class: `badge badge--${valor > 0 ? "in" : "out"}`,
    text: `${prefijo}${valor}`,
  });
}

// Insignia de almacén: un chip con color estable por nombre (paleta tag--c1..c8).
// Los almacenes son un catálogo sin significado semántico ni orden fijo en cada
// llamada, así que el color sale de un hash del nombre para que sea consistente
// en toda la app sin depender de una lista de ids.
function hashColor(texto) {
  let h = 0;
  for (let i = 0; i < texto.length; i++) h = (h * 31 + texto.charCodeAt(i)) | 0;
  return (Math.abs(h) % 8) + 1;
}

export function badgeAlmacen(nombre) {
  return badgeChip(nombre, { vacio: "Sin almacén" });
}

// Chip con color estable por texto (hash del nombre -> paleta tag--c1..c8) y
// punto. Sirve para cualquier etiqueta de catálogo sin orden fijo: almacén,
// unidad operativa, etc.
export function badgeChip(nombre, { vacio = "—" } = {}) {
  const limpio = nombre == null ? "" : String(nombre).trim();
  if (!limpio) {
    return el("span", { class: "tag tag--none" }, [
      el("span", { class: "tag__dot" }), document.createTextNode(vacio),
    ]);
  }
  return el("span", { class: `tag tag--c${hashColor(limpio.toLowerCase())}` }, [
    el("span", { class: "tag__dot" }), document.createTextNode(limpio),
  ]);
}
