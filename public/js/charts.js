// Utilidades de gráfico compartidas (SVG, sin librerías). Nace del Panel para
// que otras vistas con su propia pestaña "Dashboard" (p. ej. Equipos) puedan
// dibujar el mismo tipo de barra horizontal sin duplicar el código.
import { el, clear, buildTable } from "./ui.js";

const INK = "#1f2333";
const INK2 = "#737890";
const BASE = "#d4d6e2";

const nf = new Intl.NumberFormat("es-PE");
export const fmtNum = (n) => nf.format(Math.round(Number(n) || 0));

export function svgEl(w, h) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", `0 0 ${w} ${h}`);
  s.setAttribute("width", "100%");
  s.setAttribute("preserveAspectRatio", "xMinYMin meet");
  s.setAttribute("role", "img");
  s.style.display = "block";
  return s;
}

export function svgNode(tag, attrs, text) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

export function wrapSvg(svg) {
  return el("div", { class: "dash-chart" }, [svg]);
}

// Barra con extremo derecho redondeado, base cuadrada a la izquierda.
function barraDer(x, y, w, h, r) {
  r = Math.min(r, w, h / 2);
  return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`;
}

function recorta(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Tabla gemela de un gráfico de barras de una sola serie: mismas dos
// columnas (etiqueta, valor) que espera el toggle de `tarjetaGrafico`.
export function tablaSimple(rows, c1, c2, fmt = fmtNum) {
  return buildTable(
    [{ key: "label", label: c1 }, { key: "value", label: c2, render: (r) => el("span", { class: "mono", text: fmt(r.value) }) }],
    rows, null
  );
}

// Tarjeta con conmutador gráfico <-> tabla: todo gráfico tiene su gemela en
// tabla, para quien prefiera leer números exactos en vez de barras.
// `hazGrafico`/`hazTabla` son funciones (no nodos ya construidos) porque el
// toggle vuelve a llamarlas en cada clic, sin recordar el nodo anterior.
export function tarjetaGrafico(titulo, subtitulo, hazGrafico, hazTabla) {
  const cuerpo = el("div", { class: "dash-card__body" }, [hazGrafico()]);
  let mostrandoTabla = false;
  const toggle = el("button", {
    class: "dash-card__toggle", type: "button", text: "Ver tabla",
    onclick: () => {
      mostrandoTabla = !mostrandoTabla;
      clear(cuerpo);
      cuerpo.appendChild(mostrandoTabla ? hazTabla() : hazGrafico());
      toggle.textContent = mostrandoTabla ? "Ver gráfico" : "Ver tabla";
    },
  });
  return el("section", { class: "dash-card" }, [
    el("div", { class: "dash-card__head" }, [
      el("div", {}, [
        el("h3", { class: "dash-card__title", text: titulo }),
        el("p", { class: "dash-card__sub", text: subtitulo }),
      ]),
      toggle,
    ]),
    cuerpo,
  ]);
}

export function leyenda(items) {
  return el("div", { class: "dash-legend" },
    items.map(([txt, color]) =>
      el("span", { class: "dash-legend__item" }, [
        el("span", { class: "dash-legend__swatch", style: `background:${color}` }),
        el("span", { text: txt }),
      ])
    )
  );
}

// ¿El color de relleno es claro? (para elegir tinta o blanco en la etiqueta)
function esClaro(hex) {
  const m = String(hex).replace("#", "");
  const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150;
}

// Barra apilada única (parte-del-todo, <=6 segmentos). Un color destaca, el
// resto en gris: es la forma "énfasis", no un pastel.
export function barraApilada(segmentos, fmt = fmtNum) {
  const total = segmentos.reduce((s, x) => s + (Number(x.value) || 0), 0);
  if (!total) return el("p", { class: "dash-empty", text: "Sin datos todavía." });
  const W = 640, H = 60, x0 = 4, x1 = W - 4, y = 16, h = 26;
  const svg = svgEl(W, H);
  let x = x0;
  segmentos.forEach((seg, i) => {
    const w = Math.max(0, ((x1 - x0) * (Number(seg.value) || 0)) / total);
    if (w <= 0) return;
    const gap = i < segmentos.length - 1 ? 2 : 0; // 2px de superficie entre segmentos
    const rect = svgNode("rect", { x, y, width: Math.max(1, w - gap), height: h, rx: 3, fill: seg.color });
    rect.appendChild(svgNode("title", {}, `${seg.label}: ${fmt(seg.value)} (${Math.round((seg.value / total) * 100)}%)`));
    svg.appendChild(rect);
    if (w - gap > 30) {
      svg.appendChild(svgNode("text", {
        x: x + (w - gap) / 2, y: y + h / 2, "text-anchor": "middle", "dominant-baseline": "central",
        "font-size": "12", "font-weight": "700", fill: esClaro(seg.color) ? INK : "#ffffff",
      }, fmt(seg.value)));
    }
    x += w;
  });
  return el("div", {}, [leyenda(segmentos.map((s) => [s.label, s.color])), wrapSvg(svg)]);
}

// Barras horizontales, una sola serie (un color para todas las barras).
export function barrasH(rows, color, fmt = fmtNum) {
  if (!rows.length) return el("p", { class: "dash-empty", text: "Sin datos todavía." });
  const W = 640, rh = 34, padT = 6, padB = 6;
  const H = padT + padB + rows.length * rh;
  const labelW = 150, valW = 54;
  const x0 = labelW, x1 = W - valW;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const svg = svgEl(W, H);

  rows.forEach((r, i) => {
    const cy = padT + i * rh + rh / 2;
    const bw = Math.max(2, ((x1 - x0) * r.value) / max);
    const bh = 18;
    svg.appendChild(svgNode("text", {
      x: labelW - 12, y: cy, "text-anchor": "end", "dominant-baseline": "central",
      "font-size": "12", fill: INK2,
    }, recorta(r.label, 22)));
    const bar = svgNode("path", { d: barraDer(x0, cy - bh / 2, bw, bh, 4), fill: color });
    bar.appendChild(svgNode("title", {}, `${r.label}: ${fmt(r.value)}`));
    svg.appendChild(bar);
    svg.appendChild(svgNode("text", {
      x: x0 + bw + 8, y: cy, "dominant-baseline": "central",
      "font-size": "12", "font-weight": "600", fill: INK, "font-variant-numeric": "tabular-nums",
    }, fmt(r.value)));
  });
  svg.appendChild(svgNode("line", { x1: x0, y1: padT, x2: x0, y2: H - padB, stroke: BASE, "stroke-width": "1" }));
  return wrapSvg(svg);
}

// Columna con tope redondeado, base cuadrada abajo.
function columnaSup(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

// Barras verticales (columnas), una sola serie. Pensadas para pocas
// categorías con etiquetas cortas: a diferencia de barrasH (donde el nombre
// va al costado y puede ser largo), aquí va debajo de cada columna y un
// texto largo se solaparía con el vecino.
export function columnasV(rows, color, fmt = fmtNum) {
  if (!rows.length) return el("p", { class: "dash-empty", text: "Sin datos todavía." });
  const W = 640, H = 300;
  const padL = 10, padR = 10, padT = 24, padB = 40;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const svg = svgEl(W, H);
  const baseY = padT + plotH;

  svg.appendChild(svgNode("line", { x1: padL, y1: baseY, x2: W - padR, y2: baseY, stroke: BASE, "stroke-width": "1" }));

  const bandW = plotW / rows.length;
  const colW = Math.min(56, bandW * 0.55);
  const maxCaracteres = Math.max(6, Math.floor(bandW / 7));

  rows.forEach((r, i) => {
    const cx = padL + i * bandW + bandW / 2;
    const h = Math.max(2, (plotH * r.value) / max);
    const y = baseY - h;
    const bar = svgNode("path", { d: columnaSup(cx - colW / 2, y, colW, h, 4), fill: color });
    bar.appendChild(svgNode("title", {}, `${r.label}: ${fmt(r.value)}`));
    svg.appendChild(bar);
    if (h > 16) {
      svg.appendChild(svgNode("text", {
        x: cx, y: y - 6, "text-anchor": "middle",
        "font-size": "12", "font-weight": "600", fill: INK, "font-variant-numeric": "tabular-nums",
      }, fmt(r.value)));
    }
    svg.appendChild(svgNode("text", {
      x: cx, y: baseY + 16, "text-anchor": "middle", "font-size": "11", fill: INK2,
    }, recorta(r.label, maxCaracteres)));
  });

  return wrapSvg(svg);
}
