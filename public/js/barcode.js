// Render de códigos de barras con JsBarcode (vendor local).
import { el, openModal, toast, imprimirZona } from "./ui.js";

// Celda compacta para tablas: el código en monoespaciada + barras pequeñas.
export function renderBarcode(value) {
  if (!value) return document.createTextNode("—");

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "barcode barcode--inline");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Código de barras ${value}`);

  const wrap = el("div", { class: "barcode-cell" }, [
    svg,
    el("span", { class: "barcode-cell__value mono", text: value }),
  ]);

  draw(svg, value, { height: 26, width: 1, margin: 0, displayValue: false });
  return wrap;
}

// Etiqueta grande, para el formulario o para imprimir.
// `lineColor` se fija en la etiqueta imprimible: si heredara el color del tema,
// en modo oscuro saldría blanco sobre blanco en el papel.
export function renderBarcodeLabel(value, { height = 54, lineColor } = {}) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "barcode");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Código de barras ${value}`);
  draw(svg, value, {
    height, width: 1.6, margin: 6, displayValue: true, fontSize: 13,
    ...(lineColor ? { lineColor } : {}),
  });
  return svg;
}

// Modal de etiqueta imprimible. La etiqueta es lo único que llega al papel:
// una regla @media print oculta el resto de la página.
//
// El código de barras impreso es siempre el campo `codigo_barras` del producto.
// En un componente ese campo ya contiene su serie (o su código interno).
export function abrirEtiqueta(producto) {
  if (!producto?.codigo_barras) {
    toast("Ese producto todavía no tiene código de barras.", "error");
    return;
  }

  const esComponente = !!producto?.es_trazable;
  const etiqueta = el("div", { class: "etiqueta zona-impresion" }, [
    el("p", { class: "etiqueta__nombre", text: producto.nombre }),
    el("div", { class: "etiqueta__datos" }, [
      producto.no_parte ? dato("No. parte", producto.no_parte) : null,
      producto.no_serie ? dato("Serie", producto.no_serie) : null,
      esComponente && producto.codigo_interno ? dato("Cód. interno", producto.codigo_interno) : null,
      producto.marca ? dato("Marca", producto.marca) : null,
    ]),
    renderBarcodeLabel(producto.codigo_barras, { height: 70, lineColor: "#111111" }),
  ]);

  const body = el("div", { class: "modal__body" }, [
    etiqueta,
    el("p", { class: "form-hint", text: "Al imprimir solo sale la etiqueta; el resto de la pantalla se omite." }),
  ]);

  openModal({
    title: "Etiqueta del producto",
    body,
    submitLabel: "Imprimir",
    readOnly: true,
    onSubmit: async () => imprimirZona(),
  });
}

function dato(etiqueta, valor) {
  return el("div", { class: "etiqueta__dato" }, [
    el("span", { class: "etiqueta__label", text: etiqueta }),
    el("span", { class: "mono", text: valor }),
  ]);
}

function draw(svg, value, opts) {
  if (typeof window.JsBarcode !== "function") return;
  try {
    window.JsBarcode(svg, String(value), {
      format: "CODE128",
      lineColor: getComputedStyle(document.body).getPropertyValue("--text").trim() || "#000",
      background: "transparent",
      ...opts,
    });
  } catch {
    // Un valor no codificable no debe romper la tabla: se queda el texto.
  }
}
