// Escáner de códigos de barras con la cámara del dispositivo.
//
// Usa ZXing como global UMD (`window.ZXing`, cargado en index.html antes de
// app.js). `botonEscanear` devuelve un botón listo para poner junto a un campo
// de búsqueda; al leer un código llama al callback con el texto y cierra.
//
// Requisitos del navegador: contexto seguro (HTTPS o localhost) para que
// `navigator.mediaDevices` exista, y que ZXing haya cargado. Si algo falta,
// `botonEscanear` devuelve null y el botón simplemente no aparece.
import { el, iconButton, toast } from "./ui.js";
import { icon } from "./icons.js";

export function escanerDisponible() {
  return (
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
    typeof window.ZXing?.BrowserMultiFormatReader === "function"
  );
}

// Botón para escanear, o null si el navegador no puede (sin cámara, contexto no
// seguro, o ZXing no cargó). Los llamadores hacen:
//   const b = botonEscanear(fn); if (b) contenedor.appendChild(b);
// Por defecto es un botón cuadrado de icono; con `{ texto: true }` es un botón
// normal "▣ Escanear" (para ir al lado de un campo alto o como celda de filtro).
export function botonEscanear(onCodigo, { texto = false, bloque = false } = {}) {
  if (!escanerDisponible()) return null;
  if (texto) {
    return el("button", {
      class: `btn btn--ghost${bloque ? " btn--block" : ""}`, type: "button",
      onclick: () => abrirEscaner(onCodigo),
      html: `${icon("scan", { size: 16, stroke: 1.9 })}<span>Escanear</span>`,
    });
  }
  return iconButton("Escanear código de barras", "btn--ghost", () => abrirEscaner(onCodigo), "scan");
}

export function abrirEscaner(onCodigo) {
  if (!escanerDisponible()) {
    toast("Este navegador no puede usar la cámara para escanear.", "error");
    return;
  }

  const video = el("video", { class: "scanner__video", autoplay: "", playsinline: "" });
  // iOS exige la propiedad, no solo el atributo, para reproducir en línea y sin sonido.
  video.muted = true;
  video.playsInline = true;

  const btnLinterna = el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "Linterna" });
  btnLinterna.hidden = true;
  const btnCancelar = el("button", {
    class: "btn btn--ghost btn--sm", type: "button", text: "Cancelar", onclick: () => cerrar(),
  });
  const cerrarX = el("button", {
    class: "modal__close", type: "button", html: "&times;", "aria-label": "Cerrar", onclick: () => cerrar(),
  });

  const overlay = el("div", { class: "modal-overlay" }, [
    el("div", { class: "modal modal--scanner", role: "dialog", "aria-modal": "true", "aria-label": "Escanear código de barras" }, [
      el("div", { class: "modal__header" }, [
        el("div", { class: "modal__heading" }, [
          el("h3", { class: "modal__title", text: "Escanear código" }),
          el("p", { class: "modal__subtitle", text: "Centra el código de barras en el recuadro." }),
        ]),
        cerrarX,
      ]),
      el("div", { class: "scanner__body" }, [
        video,
        el("div", { class: "scanner__frame", "aria-hidden": "true" }),
      ]),
      el("div", { class: "scanner__actions" }, [btnLinterna, btnCancelar]),
    ]),
  ]);

  document.body.appendChild(overlay);
  document.body.classList.add("no-scroll");
  requestAnimationFrame(() => overlay.classList.add("modal-overlay--show"));

  let cerrado = false;
  let reader = null;

  function onEsc(e) { if (e.key === "Escape") cerrar(); }
  document.addEventListener("keydown", onEsc);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) cerrar(); });

  function pararCamara() {
    try { reader?.reset(); } catch { /* noop */ }
    const s = video.srcObject;
    if (s && s.getTracks) s.getTracks().forEach((t) => { try { t.stop(); } catch { /* noop */ } });
    video.srcObject = null;
  }

  function cerrar() {
    if (cerrado) return;
    cerrado = true;
    document.removeEventListener("keydown", onEsc);
    pararCamara();
    overlay.remove();
    document.body.classList.remove("no-scroll");
  }

  // Cuando el vídeo empieza a reproducir, la pista ya está en video.srcObject:
  // ahí se puede consultar si la cámara tiene linterna.
  video.addEventListener("playing", configurarLinterna, { once: true });

  // Solo formatos 1D + TRY_HARDER: la app usa CODE-128 (etiquetas propias) y
  // EAN/UPC (códigos de fábrica). Restringir los formatos hace que ZXing use
  // únicamente el lector 1D y mejora bastante la precisión y la velocidad.
  let hints;
  const { DecodeHintType, BarcodeFormat } = window.ZXing || {};
  if (DecodeHintType && BarcodeFormat) {
    hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF,
      BarcodeFormat.CODABAR, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
    ]);
    hints.set(DecodeHintType.TRY_HARDER, true);
  }

  reader = new window.ZXing.BrowserMultiFormatReader(hints, 120);
  reader
    .decodeFromConstraints(
      {
        video: {
          facingMode: { ideal: "environment" },
          // Todo con `ideal` / `advanced`: nunca lanza OverconstrainedError.
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
          advanced: [{ focusMode: "continuous" }],
        },
      },
      video,
      (result) => {
        if (cerrado || !result) return; // sin `result` = frame sin código, se ignora
        const texto = (result.getText && result.getText()) || String(result);
        cerrar();
        onCodigo(texto);
      }
    )
    .catch((err) => {
      const nombre = err && err.name;
      const msg =
        nombre === "NotAllowedError" || nombre === "SecurityError"
          ? "Permiso de cámara denegado."
          : nombre === "NotFoundError" || nombre === "OverconstrainedError"
          ? "No se encontró una cámara."
          : "No se pudo abrir la cámara.";
      toast(msg, "error");
      cerrar();
    });

  function configurarLinterna() {
    if (cerrado) return;
    const track = video.srcObject && video.srcObject.getVideoTracks && video.srcObject.getVideoTracks()[0];
    if (!track || !track.getCapabilities) return;
    let caps;
    try { caps = track.getCapabilities(); } catch { return; }
    if (!caps || !("torch" in caps)) return;

    let encendida = false;
    btnLinterna.hidden = false;
    btnLinterna.onclick = async () => {
      encendida = !encendida;
      try {
        await track.applyConstraints({ advanced: [{ torch: encendida }] });
        btnLinterna.classList.toggle("btn--primary", encendida);
      } catch {
        // Algunos equipos no permiten alternar la linterna con la cámara activa.
        encendida = !encendida;
        toast("Este dispositivo no permite encender la linterna aquí.", "error");
      }
    };
  }
}
