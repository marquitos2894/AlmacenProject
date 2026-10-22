// Ticket en PDF y envío por WhatsApp (Movimientos y Transferencias).
//
// El PDF se arma por código (jsPDF + autoTable), no como captura de pantalla:
// pesa unas decenas de KB, el texto es nítido y se puede seleccionar. Las
// librerías (~450 KB) se cargan solo al pulsar el botón, como ExcelJS en Equipos.
//
// WhatsApp no permite adjuntar un archivo desde un enlace (wa.me solo lleva
// texto), así que se usa la Web Share API con archivos: abre el menú de
// compartir del sistema, donde aparece WhatsApp con el PDF ya adjunto. Donde el
// navegador no la soporta (Firefox de escritorio…) se descarga el PDF y se abre
// WhatsApp con el resumen en texto para que el usuario adjunte el archivo.
import { el, toast } from "./ui.js";

const LOGO = "img/logo/corimayologo.png";
const LIBS = ["./vendor/jspdf.js", "./vendor/jspdf-autotable.js"];

let cargaLibs;
function cargarScript(src) {
  return new Promise((ok, fallo) => {
    const s = el("script", { src });
    s.onload = ok;
    s.onerror = () => fallo(new Error("No se pudo cargar el generador de PDF"));
    document.head.appendChild(s);
  });
}
// En orden: el plugin de tablas necesita que jsPDF ya exista.
function cargarLibsPdf() {
  if (window.jspdf?.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  cargaLibs ||= (async () => {
    for (const src of LIBS) await cargarScript(src);
    return window.jspdf.jsPDF;
  })().catch((e) => { cargaLibs = null; throw e; });
  return cargaLibs;
}

// El logo original es de 1024×1024 (200 KB): se reduce para no engordar cada PDF.
async function logoDataUrl(px = 160) {
  try {
    const blob = await (await fetch(LOGO)).blob();
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = px;
    canvas.getContext("2d").drawImage(bmp, 0, 0, px, px);
    return canvas.toDataURL("image/png");
  } catch {
    return null; // sin logo el ticket sigue siendo válido
  }
}

const texto = (v) => (v == null || String(v).trim() === "" ? "—" : String(v));

// `datos`: [[clave, valor], …] (ya sin vacíos). `columnas`: [{ label, valor(fila),
// derecha? }] en texto plano. Devuelve un File PDF A4 listo para compartir.
export async function generarTicketPdf({ titulo, folio, datos, observaciones, columnas, filas, pie }) {
  const [jsPDF, logo] = await Promise.all([cargarLibsPdf(), logoDataUrl()]);
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  const ancho = doc.internal.pageSize.getWidth();
  const margen = 14;
  let y = 14;

  if (logo) doc.addImage(logo, "PNG", margen, y - 2, 16, 16);
  doc.setFont("helvetica", "bold").setFontSize(15).setTextColor(17);
  doc.text(titulo, margen + (logo ? 20 : 0), y + 4);
  doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(91, 100, 114);
  doc.text("Folio", ancho - margen, y + 1, { align: "right" });
  doc.setFont("courier", "bold").setFontSize(13).setTextColor(17);
  doc.text(texto(folio), ancho - margen, y + 7, { align: "right" });
  y += 20;

  doc.setDrawColor(200).line(margen, y, ancho - margen, y);
  y += 6;

  // Rejilla de datos a dos columnas (clave pequeña arriba, valor debajo). Cada
  // fila mide lo que la más alta de sus dos celdas.
  const colAncho = (ancho - margen * 2) / 2;
  for (let i = 0; i < datos.length; i += 2) {
    let alto = 0;
    datos.slice(i, i + 2).forEach(([clave, valor], j) => {
      const x = margen + j * colAncho;
      doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(91, 100, 114);
      doc.text(String(clave).toUpperCase(), x, y);
      doc.setFont("helvetica", "bold").setFontSize(10).setTextColor(17);
      const lineas = doc.splitTextToSize(texto(valor), colAncho - 4);
      doc.text(lineas, x, y + 4.5);
      alto = Math.max(alto, 4.5 + lineas.length * 4.2 + 3);
    });
    y += alto;
  }

  if (observaciones && String(observaciones).trim()) {
    y += 1;
    doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(91, 100, 114);
    doc.text("OBSERVACIONES", margen, y);
    doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(17);
    const lineas = doc.splitTextToSize(String(observaciones).trim(), ancho - margen * 2);
    doc.text(lineas, margen, y + 4.5);
    y += 4.5 + lineas.length * 4.2 + 3;
  }

  doc.autoTable({
    startY: y + 2,
    margin: { left: margen, right: margen, bottom: 16 },
    head: [columnas.map((c) => c.label)],
    body: filas.map((f) => columnas.map((c) => texto(c.valor(f)))),
    styles: { font: "helvetica", fontSize: 8.5, cellPadding: 2, textColor: 17, overflow: "linebreak" },
    headStyles: { fillColor: [236, 239, 245], textColor: 40, fontStyle: "bold" },
    columnStyles: Object.fromEntries(columnas.map((c, i) => [i, c.derecha ? { halign: "right" } : {}])),
    theme: "grid",
    didDrawPage: () => {
      const n = doc.internal.getNumberOfPages();
      doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(91, 100, 114);
      doc.text(`${pie} · Página ${n}`, margen, doc.internal.pageSize.getHeight() - 8);
    },
  });

  const nombre = `Ticket-${String(folio || "sin-folio").replace(/[^\w.-]+/g, "_")}.pdf`;
  return new File([doc.output("blob")], nombre, { type: "application/pdf" });
}

// Abre el menú de compartir con el PDF adjunto; si el navegador no puede
// compartir archivos, lo descarga y abre WhatsApp con el resumen.
export async function compartirTicketPdf(archivo, resumen) {
  if (navigator.canShare?.({ files: [archivo] })) {
    try {
      await navigator.share({ files: [archivo], title: archivo.name, text: resumen });
    } catch (e) {
      if (e?.name !== "AbortError") throw e; // cerrar el menú no es un error
    }
    return;
  }
  const url = URL.createObjectURL(archivo);
  const a = el("a", { href: url, download: archivo.name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  window.open(`https://wa.me/?text=${encodeURIComponent(resumen)}`, "_blank", "noopener");
  toast("Se descargó el PDF. Adjúntalo en el chat de WhatsApp que se abrió.", "info");
}

// Un solo paso para los botones: genera y comparte, con aviso si algo falla.
export async function enviarTicketPorWhatsApp(ticket, resumen) {
  try {
    toast("Preparando el PDF…", "info");
    await compartirTicketPdf(await generarTicketPdf(ticket), resumen);
  } catch (e) {
    toast(`No se pudo compartir el ticket: ${e.message}`, "error");
  }
}
