# Sistema de Gestión de Almacén

SPA en **Vanilla JS** que se conecta directamente a **Supabase** (PostgREST + Auth + RLS).
No hay servidor propio: el navegador habla con Supabase usando `supabase-js`.

## Stack

- **Frontend:** HTML + CSS + JavaScript (ES modules), sin paso de build.
- **Datos/Auth/API:** Supabase (Postgres + PostgREST + Auth + RLS).
- **Librería:** `@supabase/supabase-js` (UMD, servido localmente en `public/vendor/supabase.js`).

## Estructura

```
supabase/migrations/       Esquema versionado (0001…0060, ver "Migraciones")
public/                    Sitio estático
  index.html
  css/styles.css           Admin template (claro/oscuro), WCAG AA
  vendor/                  supabase.js, jsbarcode.js, zxing.js (UMD) y exceljs.js (carga bajo demanda)
  js/
    config.js              URL + anon key (RELLENAR; plantilla en config.example.js)
    app.js                 Router por hash, sesión y navegación
    crud.js                Fábrica de pantallas CRUD (soft-delete, segmentos, búsqueda, tarjetas/tabla)
    ui.js  supabaseClient.js  auth.js  charts.js  icons.js  badges.js
    productSearch.js       Buscador de productos/existencias del carrito
    pickerModal.js         Selector genérico (equipo, establecimiento, proveedor…)
    scanner.js  barcode.js Escáner de cámara (ZXing) y códigos de barras (JsBarcode)
    views/                 Una por pantalla
scripts/dev-lan.mjs        Servidor HTTPS para probar el escáner en el móvil
AGENTS.md  CLAUDE.md       Guía para agentes de IA (reglas de dominio y convenciones)
```

Como no hay backend, **la lógica que debe ser atómica vive en funciones de Postgres**
(`registrar_movimiento`, `registrar_transferencia`, `anular_movimiento`, `set_producto_unidad`,
`cambiar_estado_existencia`) y se llama con `supabase.rpc(...)`. Las reglas se imponen con constraints,
índices y triggers, no solo en la interfaz.

## Puesta en marcha

1. **Crear el esquema.** En el proyecto Supabase → SQL Editor, ejecuta **en orden** todos los archivos de
   `supabase/migrations/` (0001 → 0060). Cada uno es idempotente y trae una cabecera `--` que explica el problema
   y la decisión. Grupos principales:
   - **0001–0005** — tablas base, RLS, vistas, movimientos con folio y `registrar_movimiento`, regla de activo
     fijo, `search_path` fijo y stock por producto + almacén + estado + ubicación.
   - **0006–0016** — unicidad de series y partes, `producto_unidad` (unidades físicas), `es_trazable`
     (antes `activofijo`), descripciones y referencias en el movimiento.
   - **0017–0021, 0027–0029, 0037, 0047** — establecimientos (`unidad_operativa`), asignaciones de equipos con
     código y horómetros, tipos de equipo.
   - **0022–0026, 0030–0036, 0056** — roles `editor`/`lector` con RLS, transferencias, reglas de salida y
     agotado, y anulación de movimientos.
   - **0038–0055** — códigos de barras e internos (`TCH-AÑO-N`), código de control por existencia, vistas de stock.
   - **0057–0059** — tipos de producto, bitácora (`log_eventos`), pertenencia a establecimiento y etiquetas.
   - **0060** — proveedores. En una base **nueva**, ejecútala justo después de la 0001: la 0022 (roles) y la 0042
     ya dependen de `proveedores` y de `movimientos.id_proveedor`.
   - **0061–0063** — el Stock Inicial acumula en vez de reemplazar; `vw_stock_agrupado` agrega códigos de barras,
     series y códigos internos (Stock por almacén con componentes); un componente nunca pasa de 1 unidad.

   Faltan a propósito los números 0011, 0012, 0015 y 0018 (huecos históricos).

2. **Crear un usuario.** Supabase → Authentication → Users → *Add user* (email + contraseña),
   o habilita el registro por email. Ese usuario es el que iniciará sesión.

3. **Configurar credenciales.** Edita `public/js/config.js`:
   ```js
   window.CONFIG = {
     url: "https://TU-PROYECTO.supabase.co",
     anonKey: "TU_ANON_O_PUBLISHABLE_KEY",
   };
   ```
   (La clave anon/publishable es pública por diseño; la seguridad la impone RLS.)

4. **Refrescar el vendor** (solo si actualizas supabase-js, jsbarcode, zxing o exceljs):
   ```bash
   npm run copy-vendor
   ```

5. **Servir el sitio** (se requiere http://, no `file://`):
   ```bash
   npm start
   ```
   Abre http://localhost:3000

### Probar la cámara (escáner) en un móvil de la misma red

El botón **Escanear** solo aparece en un **contexto seguro** (HTTPS o `localhost`): abrir la
app por `http://<IP-del-PC>:3000` desde el teléfono no lo muestra. Para probarlo antes de
publicar:

```bash
npm run dev:lan
```

Sirve `public/` por HTTPS en `0.0.0.0:3000` con un certificado autofirmado (se genera solo la
primera vez en `.cert/`, ignorado por git). En el móvil, abre `https://<IP-del-PC>:3000` y
acepta el aviso de certificado una vez; a partir de ahí la página es contexto seguro y el
escáner funciona (Chrome/Android y Safari/iOS).

Para evitar el aviso de certificado: instala [`mkcert`](https://github.com/FiloSottile/mkcert),
genera el par y añade su CA raíz al móvil. Alternativa sin certificados: `npx ngrok http 3000`
da una URL HTTPS pública temporal.

## Funcionalidad

Menú (`public/js/app.js`): Panel · Productos · Stock por almacén · Movimientos · Transferencias ·
Almacenes · Proveedores · Unidades de medida · Estados · Equipos · Tipos de equipo · Tipos de producto ·
Establecimientos · Bitácora.

**Catálogos (CRUD sin borrado físico — solo `activo=false`; las listas muestran activos):** almacenes,
proveedores, unidades de medida, estados, tipos de equipo, tipos de producto, establecimientos y equipos.
Varias listas traen buscador (`search` en `crud.js`) y alternan tarjetas/tabla/dashboard.

**Productos.** Dos clases: **consumibles** (se cuentan por stock) y **componentes trazables** (unidad física
única, con serie, modelo y código interno). Los componentes tienen "Pertenece a" (establecimiento por
defecto), tipo de producto y etiquetas `#hashtag`; los productos enlazan equipos compatibles por modelo.

**Búsqueda en Productos.** Una sola barra para Consumibles y Componentes: el texto normal busca por nombre,
n.º de parte, marca y código; si lo escrito **empieza con `#`** se filtra por etiqueta, con coincidencia parcial
(`#bom` encuentra `#bomba`) y sugerencias de las etiquetas en uso. En el Dashboard de Componentes la etiqueta
sigue siendo un combo.

**Códigos de barras** (JsBarcode; escáner con la cámara vía ZXing): consumible → su `no_parte` (o `INT-XXXXX`
autogenerado si no tiene); componente → su serie o su código interno `TCH-AÑO-N`.

**Movimientos — flujo de 3 pasos:**

1. `#/movimientos` — eliges el **almacén** en tarjetas.
2. `#/movimientos/{id}` — tickets de ese almacén, con filtros por **ticket / folio** (coincidencia parcial: `0249`
   o `TKT-261020-0249`), no. de parte, nombre y estado.
3. `#/movimientos/{id}/nuevo` — encabezado + **carrito**:
   - **Agregar producto** abre un modal de búsqueda (debounce de 300 ms) sobre no. de parte, nombre, serie,
     código interno y código de control, con badge de existencia y alta rápida de productos.
   - Referencias opcionales del movimiento: componente, equipo, establecimiento y **proveedor**.
   - **Stock Inicial**: se *suma* a la existencia (nunca la reemplaza); es una entrada marcada como carga inicial.
   - Al guardar se genera el **folio** `TKT-{AAMMDD}-{####}` y se muestra el ticket imprimible.
   - **Imprimir** abre una vista previa con el mismo PDF que se comparte, desde la que se imprime, se descarga o se
     envía; el botón **WhatsApp (PDF)** lo comparte directo: abre el menú de compartir del teléfono o del sistema con
     el PDF adjunto; en navegadores sin esa función, descarga el PDF y abre WhatsApp con el resumen para que lo
     adjuntes. Lo mismo en el ticket de Transferencias. Compartir con archivo exige HTTPS (o `localhost`); los
     navegadores móviles que no muestran PDF en la página ofrecen abrirlo en una pestaña nueva.
   - Un ticket se puede **anular**: se revierte su efecto en el stock sin borrar el historial.

El guardado usa `registrar_movimiento`: encabezado + detalle + ajuste de stock en **una sola transacción**.

**Transferencias** entre almacenes (`registrar_transferencia`, folio `TRF-…`): resta en el origen y suma o
fusiona en el destino, también en una sola transacción.

**Stock por almacén.** Incluye consumibles y componentes. Una fila por almacén + n.º de parte, **sin mirar ubicación ni
estado** (la suma la hace SQL, en `vw_stock_agrupado`): varios componentes con el mismo n.º de parte se agrupan en una
fila. Filtros por tipo, n.º de parte, nombre, serie o código interno, estado, código de control y código de barras
(escaneo). El detalle muestra cada existencia con su ubicación; ahí se puede cambiar el estado o la ubicación, pero la
cantidad **solo cambia registrando movimientos o transferencias**.

**Equipos.** Tarjetas, tabla y dashboard; asignación a establecimientos con código y horómetros;
historial; y botón **Descargar** que exporta a `.xlsx` la lista con los filtros aplicados.

**Bitácora.** Registro de quién hizo qué y cuándo, escrito por triggers en la base (no por el frontend).

**Roles.** `editor` (por defecto) y `lector` (solo consulta): la RLS lo impone y la interfaz oculta las acciones
de escritura.

## Reglas de negocio

- **Identidad del stock**: una existencia es **producto + almacén + estado + ubicación** (+ **código de
  control**: N.º de OT o código del proveedor). Si un movimiento trae un estado, una ubicación o un código
  distintos, **no se suma**: se crea una existencia nueva. Lo garantiza el índice `uq_producto_almacen_grano`
  (con `NULLS NOT DISTINCT`).
- **Ubicación normalizada**: `A-7`, `a-7` y `A-7 ` son la misma. La columna generada `ubicacion_norm`
  (`upper(btrim(...))`) es la que se indexa; `ubicacion` conserva lo que escribió el usuario.
- **Componentes trazables** (`es_trazable`): una pieza = un código interno = **una unidad**; nunca más de 1 en
  stock (lo impone `registrar_movimiento` y un CHECK, 0063). Otra pieza igual es un producto nuevo con su propio
  código. Solo pueden existir en **un almacén** y no se duplican. Cambiarles
  el estado o la ubicación **muda** su fila. Una salida total los saca del inventario (la existencia se
  desactiva). Estado y ubicación canónicos viven en `producto_almacen`.
- **Consumibles**: al agotarse pierden su ubicación, y sus existencias vacías se consolidan para no fragmentar
  el stock.
- **Salidas**: el renglón identifica la existencia exacta (`producto_almacen_id`); una salida nunca deja el
  stock por debajo de cero.
- **Stock Inicial** acumula como una entrada: no pisa el stock que ya tiene la existencia (0061). Anularlo resta su cantidad.
- **Equipos**: solo una asignación abierta por equipo; su estado y establecimiento actuales se derivan de ella.
- **Proveedores**: ni el código ni el RUC pueden repetirse entre proveedores activos.

## Notas de diseño

- `usuarios` se sincroniza solo al iniciar sesión (enlace `auth_uid` con `auth.users`); no tiene pantalla.
- `movimientos` es un log (sin `activo`); anular no borra.
- RLS: lectura abierta a `authenticated`; INSERT/UPDATE/DELETE exigen `puede_editar()`. Los RPC corren con
  los permisos de quien llama, así que también quedan bloqueados para `lector`.
- Postgres pasa a minúsculas los identificadores sin comillas (`activoFijo` se guardó como `activofijo`).
- PostgREST devuelve como máximo 1000 filas por consulta, **sin avisar**: para agregar en cliente se usa
  `fetchAll()` de `supabaseClient.js`.
- Paleta con tokens de tinta separados (`--*-ink`) para que todo el texto cumpla contraste
  **WCAG AA (4.5:1)** en tema claro y oscuro.
