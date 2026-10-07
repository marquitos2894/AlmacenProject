# AGENTS.md — Almacén TCH (Corimayo)

Guía para agentes de IA que trabajen en este repositorio. Idioma del proyecto: **español**
(UI, comentarios, mensajes de commit y nombres de dominio).

## Qué es

SPA de gestión de inventario/almacén en **Vanilla JS (ES modules), sin build ni framework**,
que habla directo con **Supabase** (Postgres + PostgREST + Auth + RLS). No hay servidor propio.
La seguridad y las reglas de negocio viven en la **base de datos** (RLS, triggers, RPC), no en el cliente.

## Comandos

```bash
npm install
npm start            # serve public → http://localhost:3000
npm run dev:lan      # HTTPS autofirmado en 0.0.0.0:3000 (el escáner de cámara exige contexto seguro)
npm run copy-vendor  # refresca public/vendor/ (supabase-js, jsbarcode, zxing, exceljs) desde node_modules
```

No hay tests, linter ni paso de build. Verifica los cambios de UI en el navegador
(Playwright/Chromium está disponible en el entorno cloud) y los de SQL contra Supabase.

## Estructura

```
public/index.html, css/styles.css     Shell + estilos (tema claro/oscuro, tokens --*-ink, contraste WCAG AA)
public/js/config.js                   window.CONFIG {url, anonKey}; plantilla en config.example.js
public/js/app.js                      Router por hash (#/ruta), NAV, shell (sidebar/topbar)
public/js/supabaseClient.js           Cliente compartido + fetchAll() (paginación >1000 filas)
public/js/auth.js                     Sesión, ensureUsuario, puedeEditar() (rol 'lector' = solo lectura)
public/js/crud.js                     createCrudView(config): CRUD estándar con soft-delete, segmentos, tarjetas/tabla/dashboard
public/js/ui.js                       el(), toast, openModal, confirmDialog, buildField/readField, buildTable, paginador
public/js/…                           pickerModal, productSearch, productoForm, asignacionForm, scanner (zxing),
                                      barcode (JsBarcode), charts, badges, icons, historialProducto/Equipo,
                                      cambioEstadoExistencia
public/js/views/*.js                  Una vista por pantalla (export default { render(root) })
public/vendor/                        Bundles locales (no editar a mano); exceljs se carga bajo demanda
scripts/dev-lan.mjs                   Servidor HTTPS de desarrollo
supabase/migrations/NNNN_*.sql        Esquema versionado (0001…0059)
.mcp.json                             MCP de Supabase (project_ref del proyecto)
```

Vistas/rutas (`NAV` en `app.js`): Panel, Productos, Stock por almacén, Movimientos,
Transferencias, Almacenes, Proveedores, Unidades de medida, Estados, Equipos, Tipos de equipo,
Tipos de producto, Establecimientos (`unidad_operativa`), Bitácora.

`.claude/`, `.agents/`, `.codex/`, `.impeccable/`, `.cert/` están en `.gitignore`: no se versionan.

## Convenciones de código

- Construye el DOM con `el(tag, attrs, children)` de `ui.js`; no uses `innerHTML` con datos del usuario.
- Pantallas de catálogo: reutiliza `createCrudView` (soft-delete: solo `activo=false`; las listas muestran activos).
- Todo acceso a datos va por `supabase` de `supabaseClient.js`. Si necesitas **todas** las filas para
  agregar en cliente, usa `fetchAll(() => query)`; PostgREST corta en 1000 filas **en silencio**.
- Prefiere paginación/agregación en servidor (vistas `vw_*`) antes que traer tablas completas.
- Respeta `puedeEditar()` para ocultar acciones de escritura (la RLS es la barrera real).
- Escritura multi-tabla/stock ⇒ **RPC transaccional**, nunca varias llamadas desde el cliente.
- Mantén el estilo existente: comentarios en español que explican el *porqué*, nombres en español
  (`unidad_operativa`, `codigo_control`, `producto_almacen`…), tokens de color de `styles.css`.
- Persistencia local solo para preferencias de UI (`localStorage` en try/catch).

## Base de datos (Supabase)

### Migraciones
- Un archivo por cambio, numeración correlativa (`0060_…` es la siguiente). Hay huecos históricos
  (0011, 0012, 0015, 0018): no los rellenes.
- Escríbelas **idempotentes** (`if not exists`, `create or replace`, `drop … if exists`) y con
  cabecera `--` que explique el problema y la decisión.
- Si cambias una columna/tabla, **busca todas las vistas y funciones que la usan** (precedentes: 0010 y 0013
  rompieron vistas/funciones por un `DROP … CASCADE` o un renombrado incompleto). Recrea las vistas afectadas.
- Funciones: fija `search_path` (0004). Usa `SECURITY DEFINER` solo cuando haga falta (p. ej. crear secuencias, 0054).
- Los cambios se aplican en Supabase (SQL Editor o MCP); si el MCP no conecta, deja el SQL listo y avisa.

### Modelo de dominio (reglas que no debes romper)
- **Producto** = artículo de catálogo (`productos`). Puede ser **consumible** (no trazable, se cuenta por stock)
  o **componente trazable** (`es_trazable`, antes `activofijo`; unidad física única, vive en `producto_unidad` con
  serie/modelo/`codigo_interno`).
- **Existencia** (`producto_almacen`) = producto + almacén + estado + ubicación (+ **código de control**: N.º OT/código
  de proveedor, mig. 0042). Índice único `uq_producto_almacen_grano` con `NULLS NOT DISTINCT`. Estados/ubicaciones
  distintos **no se suman**: crean otra existencia. `ubicacion_norm` (`upper(btrim)`) es lo que se indexa.
- **Trazables**: solo en un almacén, no se duplican; cambiar estado/ubicación **muda** la fila. Estado y ubicación
  canónicos viven en `producto_almacen`; `productos.estado_actual/ubicacion_actual` se derivan por trigger (0023).
  Una salida total desactiva la existencia (0026, 0050); un consumible agotado pierde su ubicación (0030) y sus
  existencias vacías se consolidan (0032).
- **Movimientos** (`movimientos` + `movimiento_detalle`, folio `TKT-AAMMDD-####`): se crean **solo** con la RPC
  `registrar_movimiento`. El stock **no se edita a mano**: solo vía movimientos, transferencias,
  `cambiar_estado_existencia` o `anular_movimiento` (reversión retroactiva, no borra historial, 0056).
  *Stock Inicial* reemplaza (no suma) esa existencia. El detalle guarda foto de estado/ubicación/código de control.
- **Transferencias** (`registrar_transferencia`, folio `TRF-…`): resta en origen y suma/fusiona en destino; una
  transferencia total desactiva el origen (0033).
- **Códigos**: `codigo_barras` de consumible = `no_parte` (0040); sin `no_parte` ⇒ `INT-XXXXX` (0041); componente ⇒
  su serie o `codigo_interno` (0039); `codigo_interno` = `TCH-AÑO-N` con secuencia anual a prueba de colisión (0045–0055).
- **Equipos** (`equipos`) son catálogo/unidades físicas; su ubicación sale de `equipo_unidad_operativa`
  (historial de asignaciones a **establecimientos**, una abierta por equipo, `codigo_asignado`, horómetros 0027).
  `equipos.estado_actual/unidad_actual` se derivan de la asignación (0020). Compatibilidad producto↔equipo por
  **modelo** (`set_producto_equipos`).
- **Pertenencia y etiquetas** (0059): `productos.unidad_operativa_id` = establecimiento al que pertenece un
  componente por defecto; dato fijo que solo edita el usuario (las salidas no lo tocan; el destino de la
  última salida es otro dato, derivado en `vw_productos_trazables`). `productos.etiquetas text[]` = #hashtags
  libres para agrupar productos y componentes; el trigger `fn_productos_normaliza_etiquetas` las normaliza
  (minúsculas, sin `#`, sin repetidas, máx. 10). No copies el establecimiento a las etiquetas.
- **Catálogos**: unidades de medida, estados, tipos de equipo, tipos de producto, almacenes, proveedores.
- **Roles**: `usuarios.rol` = `editor` (default) | `lector` (solo SELECT). RLS por operación con `puede_editar()`;
  los RPC son `SECURITY INVOKER` y quedan bloqueados para `lector`.
- **Bitácora**: `log_eventos` la llena el trigger `fn_log_evento` (SECURITY DEFINER); el cliente solo lee. No
  escribas el log desde el frontend.
- Postgres pasa a minúsculas los identificadores sin comillas (`activoFijo` → `activofijo`).

## Seguridad

- `config.js` contiene solo la clave **anon/publishable** (pública por diseño; la protege RLS). Nunca pongas
  `service_role` ni secretos en `public/`.
- Toda tabla nueva necesita RLS: SELECT para `authenticated`; INSERT/UPDATE/DELETE con `puede_editar()`.
- Cada tabla de negocio nueva debe engancharse a `fn_log_evento` si sus cambios son eventos auditables.

## Git

- Desarrolla en la rama indicada por la sesión; commits descriptivos en español (`feat:`, `fix:`, …).
- No crees PR salvo que se pida explícitamente.

## Documentación pendiente

El `README.md` está desactualizado: su guía de puesta en marcha lista migraciones solo hasta la 0005 y no
describe Transferencias, trazables, establecimientos, roles ni la bitácora. Esta guía y las migraciones
(cabeceras `--`) son la fuente más fiel; actualiza el README cuando toques esas áreas.
