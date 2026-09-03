// Servidor de desarrollo por HTTPS para probar la cámara en un móvil de la misma red.
//
// El botón "Escanear" solo aparece en un contexto seguro (HTTPS o localhost):
// `navigator.mediaDevices` no existe cuando la página se sirve por HTTP a una IP
// de LAN. Este script genera un certificado autofirmado (una vez) y arranca
// `serve` con TLS en 0.0.0.0:3000. El navegador del móvil mostrará un aviso de
// certificado no confiable; al continuar, la página ya es contexto seguro y la
// cámara funciona (Chrome/Android y Safari/iOS).
//
//   npm run dev:lan
//
// Para un certificado sin avisos: instala `mkcert`, genera el par y su CA raíz
// en el móvil, o usa `npx ngrok http 3000`.

import { spawn } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirCert = join(raiz, ".cert");
const rutaCert = join(dirCert, "dev.pem");
const rutaKey = join(dirCert, "dev-key.pem");

// IPv4 de LAN (no internas), para el SAN del certificado y para imprimir las URLs.
function ipsLan() {
  const salida = [];
  for (const listas of Object.values(networkInterfaces())) {
    for (const ni of listas || []) {
      if (ni.family === "IPv4" && !ni.internal) salida.push(ni.address);
    }
  }
  return salida;
}

const ips = ipsLan();

if (!existsSync(rutaCert) || !existsSync(rutaKey)) {
  let selfsigned;
  try {
    selfsigned = (await import("selfsigned")).default;
  } catch {
    console.error(
      "\nFalta la dependencia `selfsigned`. Ejecuta `npm install` y vuelve a intentarlo.\n"
    );
    process.exit(1);
  }

  const altNames = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate(
    [{ name: "commonName", value: "almacen-dev" }],
    { days: 825, keySize: 2048, algorithm: "sha256", extensions: [{ name: "subjectAltName", altNames }] }
  );

  mkdirSync(dirCert, { recursive: true });
  writeFileSync(rutaCert, pems.cert);
  writeFileSync(rutaKey, pems.private);
  console.log(`Certificado autofirmado generado en ${dirCert}/`);
}

console.log("\nSirviendo public/ por HTTPS en:");
console.log("  https://localhost:3000");
for (const ip of ips) console.log(`  https://${ip}:3000`);
console.log("\nEn el móvil: abre la URL con la IP, acepta el aviso de certificado una vez.\n");

// Se ejecuta el binario de `serve` con el mismo Node, sin pasar por `npx` ni por
// un shell: así se evita el `EINVAL` de spawn de .cmd en Windows y no hay
// concatenación de argumentos.
const serveBin = require.resolve("serve/build/main.js");
const hijo = spawn(
  process.execPath,
  [serveBin, "public", "--ssl-cert", rutaCert, "--ssl-key", rutaKey, "-l", "tcp://0.0.0.0:3000"],
  { cwd: raiz, stdio: "inherit" }
);

hijo.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => hijo.kill(sig));
