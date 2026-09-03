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

let avisadoContextoInseguro = false;

export function escanerDisponible() {
  const tieneCamara = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  // Diagnóstico: la causa habitual de que no haya cámara es servir la página por
  // HTTP a una IP de LAN (no es contexto seguro). Se avisa una sola vez.
  if (!tieneCamara && window.isSecureContext === false && !avisadoContextoInseguro) {
    avisadoContextoInseguro = true;
    console.warn(
      "Escáner oculto: la página no está en un contexto seguro. Ábrela por HTTPS o desde localhost (p. ej. `npm run dev:lan`)."
    );
  }
  return tieneCamara && typeof window.ZXing?.BrowserMultiFormatReader === "function";
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

  // Barra de zoom. Se muestra cuando el vídeo arranca (configurarCamara): si la
  // cámara admite zoom por hardware controla ese; si no, hace un aumento en
  // pantalla que solo ayuda a encuadrar.
  const inpZoom = el("input", {
    class: "scanner__zoom", type: "range", min: "1", max: "4", step: "0.1", value: "1",
    "aria-label": "Zoom de la cámara",
  });
  inpZoom.hidden = true;
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
          el("p", { class: "modal__subtitle", text: "Acerca el código sin pegarlo. Usa el zoom o pellizca para acercar; toca la imagen para reenfocar." }),
        ]),
        cerrarX,
      ]),
      el("div", { class: "scanner__body" }, [
        video,
        el("div", { class: "scanner__frame", "aria-hidden": "true" }),
      ]),
      el("div", { class: "scanner__actions" }, [inpZoom, btnLinterna, btnCancelar]),
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
  // ahí se consultan y aplican enfoque, zoom y linterna.
  video.addEventListener("playing", configurarCamara, { once: true });

  // Solo formatos 1D: la app usa CODE-128 (etiquetas propias) y EAN/UPC (códigos
  // de fábrica). Restringir los formatos hace que ZXing use únicamente el lector
  // 1D, sin gastar tiempo en QR/DataMatrix/PDF417. Sin TRY_HARDER: en escaneo
  // continuo de vídeo rota la imagen y reintenta cada frame, y lo hace más lento.
  let hints;
  const { DecodeHintType, BarcodeFormat } = window.ZXing || {};
  if (DecodeHintType && BarcodeFormat) {
    hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.ITF,
      BarcodeFormat.CODABAR, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
    ]);
  }

  reader = new window.ZXing.BrowserMultiFormatReader(hints, 250);
  reader
    .decodeFromConstraints(
      {
        video: {
          facingMode: { ideal: "environment" },
          // 720p: resuelve las barras finas de una etiqueta pequeña sin el coste
          // de binarizar 1080p en cada frame (eso ya hundió la tasa de lectura).
          width: { ideal: 1280 },
          height: { ideal: 720 },
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
    .then(() => {
      // Si el modal se cerró antes de que la cámara terminara de abrir, el stream
      // recién adquirido quedaría encendido: se libera aquí.
      if (cerrado) pararCamara();
    })
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

  function configurarCamara() {
    if (cerrado) return;
    const track = video.srcObject && video.srcObject.getVideoTracks && video.srcObject.getVideoTracks()[0];
    if (!track) return;

    let caps = {};
    try { caps = (track.getCapabilities && track.getCapabilities()) || {}; } catch { /* noop */ }

    // applyConstraints con una restricción "advanced"; devuelve false si el
    // equipo no la soporta (no es un error que deba molestar al usuario).
    const aplicar = async (restriccion) => {
      try { await track.applyConstraints({ advanced: [restriccion] }); return true; }
      catch { return false; }
    };

    const soportaFoco = (modo) => Array.isArray(caps.focusMode) && caps.focusMode.includes(modo);

    // --- Enfoque continuo: el arreglo principal del "se ve borroso al acercar".
    if (soportaFoco("continuous")) aplicar({ focusMode: "continuous" });

    // --- Zoom. Por hardware si la cámara lo admite (Android Chrome, iOS 16+):
    // ZXing recibe los frames ya ampliados. Si no, aumento en pantalla, que solo
    // ayuda a encuadrar (ZXing lee la resolución intrínseca, no la escalada).
    const zoomHW = caps.zoom && typeof caps.zoom.max === "number" && caps.zoom.max > (caps.zoom.min || 1);
    let zMin = 1, zMax = 4, zStep = 0.1;
    if (zoomHW) {
      zMin = caps.zoom.min || 1;
      zMax = caps.zoom.max;
      zStep = caps.zoom.step || Math.max(0.1, (zMax - zMin) / 40);
    }
    inpZoom.min = String(zMin);
    inpZoom.max = String(zMax);
    inpZoom.step = String(zStep);
    inpZoom.value = String(zMin);
    inpZoom.hidden = false;

    const aplicarZoom = (z) => {
      const v = Math.min(zMax, Math.max(zMin, Number(z) || zMin));
      inpZoom.value = String(v);
      if (zoomHW) aplicar({ zoom: v });
      else video.style.transform = `scale(${v})`;
    };
    inpZoom.oninput = () => aplicarZoom(inpZoom.value);

    // Pellizco (dos dedos) sobre el vídeo → mismo zoom que la barra.
    let pinchBase = 0, pinchZoom = zMin;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    video.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) { pinchBase = dist(e.touches); pinchZoom = Number(inpZoom.value); }
    }, { passive: true });
    video.addEventListener("touchmove", (e) => {
      if (e.touches.length === 2 && pinchBase > 0) {
        e.preventDefault();
        aplicarZoom(pinchZoom * (dist(e.touches) / pinchBase));
      }
    }, { passive: false });
    video.addEventListener("touchend", () => { pinchBase = 0; }, { passive: true });

    // --- Toque simple (un dedo) para reenfocar donde apunta el usuario.
    video.addEventListener("click", (e) => {
      if (!soportaFoco("single-shot")) return;
      const r = video.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      (async () => {
        if (!(await aplicar({ focusMode: "single-shot", pointsOfInterest: [{ x, y }] }))) {
          await aplicar({ focusMode: "single-shot" });
        }
        // Volver a enfoque continuo tras un momento, si existe.
        setTimeout(() => { if (!cerrado && soportaFoco("continuous")) aplicar({ focusMode: "continuous" }); }, 1600);
      })();
    });

    // --- Linterna.
    if ("torch" in caps) {
      let encendida = false;
      btnLinterna.hidden = false;
      btnLinterna.onclick = async () => {
        encendida = !encendida;
        if (await aplicar({ torch: encendida })) {
          btnLinterna.classList.toggle("btn--primary", encendida);
        } else {
          // Algunos equipos no permiten alternar la linterna con la cámara activa.
          encendida = !encendida;
          toast("Este dispositivo no permite encender la linterna aquí.", "error");
        }
      };
    }
  }
}
