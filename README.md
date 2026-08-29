# Sistema de Gestión de Almacén

SPA en **Vanilla JS** que se conecta directamente a **Supabase** (PostgREST + Auth + RLS).
No hay servidor propio: el navegador habla con Supabase usando `supabase-js`.

## Stack

- **Frontend:** HTML + CSS + JavaScript (ES modules), sin paso de build.
- **Datos/Auth/API:** Supabase (Postgres + PostgREST + Auth + RLS).
- **Librerías:** `@supabase/supabase-js` y `JsBarcode`, servidas localmente desde `public/vendor/`.

Como no hay backend, **la lógica que debe ser atómica vive en funciones de Postgres**
(`registrar_movimiento`, `set_producto_unidad`, `cambiar_estado_existencia`) y se llama con
`supabase.rpc(...)`. Las reglas de negocio se imponen con constraints e índices, no solo en la
interfaz: así resisten concurrencia y no dependen de que el frontend se acuerde de validar.

## Estructura

```
supabase/migrations/       Esquema versionado (ver "Migraciones")
public/
  index.html
  css/styles.css           Admin template (claro/oscuro), WCAG AA
  vendor/                  supabase.js + jsbarcode.js (UMD)
  js/
    config.js              URL + anon key — NO versionado, copiar de config.example.js
    app.js                 Router por hash, sesión y navegación
    crud.js                Fábrica de pantallas CRUD (listas, formularios, segmentos, búsqueda)
    ui.js                  Elementos, modales, tablas, combobox, impresión
    supabaseClient.js  auth.js
    productSearch.js       Buscador de productos/existencias del carrito
    pickerModal.js         Selector genérico de un elemento con filtro
    historialProducto.js   Movimientos de un producto (modal)
    barcode.js             Códigos de barras y etiqueta imprimible
    views/                 Una por pantalla
```

## Puesta en marcha

1. **Aplicar las migraciones** de `supabase/migrations/` en orden, desde el SQL Editor de Supabase.
2. **Crear un usuario** en Supabase → Authentication → Users. Sin sesión no se ve nada: RLS
   restringe todo a `authenticated`.
3. **Configurar credenciales**: copia `public/js/config.example.js` a `public/js/config.js` y
   rellena `url` y `anonKey`. (La clave anon/publishable es pública por diseño; la seguridad la
   impone RLS. `config.js` está en `.gitignore`.)
4. **Servir el sitio** (se requiere `http://`, no `file://`):
   ```bash
   npm start
   ```
   Abre http://localhost:3000

Si actualizas las librerías: `npm run copy-vendor`.

## Modelo de datos

### Catálogos
`almacenes` · `unidades_medida` · `estados` · `equipos` · `proveedores` · `unidad_operativa` · `usuarios`

### Productos y unidades físicas

- **`productos`** — el catálogo. La bandera **`es_trazable`** parte el sistema en dos:
  - **Consumibles** (`false`): se cuentan por cantidad. Llevan unidad de medida.
  - **Trazables/Componentes** (`true`): son una máquina concreta. Su serie, código interno,
    modelo y estado viven en `producto_unidad`, no aquí.
- **`producto_unidad`** — la unidad física de un producto trazable. `descripcion` es una columna
  **generada**: `modelo/no_serie`, o `modelo/codigo_interno` si no hay serie.

> Dos productos trazables con series distintas **son productos distintos**, aunque compartan
> nombre y número de parte. Por eso `no_parte` solo es único entre consumibles.

### Stock y movimientos

- **`producto_almacen`** — una existencia es la combinación **producto + almacén + estado +
  ubicación**. No es "producto en almacén".
- **`movimientos`** — la cabecera del ticket (folio, fecha, tipo, almacén). Puede referenciar
  `id_producto_unidad`, `id_equipo`, `id_unidad_operativa` e `id_proveedor`.
- **`movimiento_detalle`** — las líneas del carrito, cada una apuntando a la existencia exacta.

### Equipos y proyectos

- **`equipos`** — catálogo de maquinaria.
- **`equipo_unidad_operativa`** — historial de a qué proyecto minero está asignado cada equipo.
  Una fila **sin `fecha_fin` es la asignación vigente**.

## Reglas de negocio

Todas están impuestas en la base de datos, no solo en la interfaz.

| Regla | Cómo se garantiza |
|---|---|
| Sin borrado físico: solo `activo = false`, y las listas muestran solo activos | Convención en `crud.js` |
| Una existencia es producto + almacén + estado + ubicación; un estado o ubicación distintos **crean una nueva**, no suman | `uq_producto_almacen_grano` con `NULLS NOT DISTINCT` |
| `A-7`, `a-7` y `A-7 ` son la misma ubicación | Columna generada `ubicacion_norm` (`upper(btrim(...))`), que es la indexada |
| Un artículo **trazable** ocupa una sola existencia activa | `uq_producto_almacen_trazable` |
| Un trazable ya en inventario **solo admite salidas**; vuelve a admitir entrada cuando su stock llega a 0 | Validación en `registrar_movimiento` |
| Cambiarle estado o ubicación a un trazable lo **traslada**, no lo duplica | `cambiar_estado_existencia` |
| Una **serie** y un **código interno** no se repiten entre unidades activas | `uq_producto_unidad_no_serie`, `uq_producto_unidad_codigo_interno` |
| `no_parte` único **solo entre consumibles** (los trazables lo comparten entre unidades) | `uq_productos_no_parte_consumible` |
| Un equipo no puede estar en dos unidades operativas a la vez | `uq_euo_asignacion_abierta` (máx. una sin `fecha_fin`) |
| Dos equipos no comparten `codigo_asignado` vigente en la misma unidad | `uq_euo_codigo_asignado_vigente` |
| Código y RUC únicos entre proveedores activos | `uq_proveedores_codigo`, `uq_proveedores_ruc` |
| **Stock Inicial** sobrescribe solo esa existencia; una entrada suma y una salida resta, nunca bajo cero | `registrar_movimiento` |
| Las salidas descuentan de una existencia **identificada**, sin repartos automáticos | El renglón manda `producto_almacen_id` |

### Valores derivados (no se capturan a mano)

- `producto_unidad.descripcion` — columna generada.
- `productos.codigo_barras` — trigger: manual → `BAR-{no_parte}` → `SYS-{id}`.
- `movimientos.folio` — trigger: `TKT-{AAMMDD}-{####}` desde una secuencia.
- `equipos.unidad_actual` y `equipos.estado_actual` — trigger que los toma de la asignación más
  reciente en `equipo_unidad_operativa`. **Editarlos a mano no sirve**: el siguiente cambio de
  asignación los pisa, por eso no están en el formulario.

## Pantallas

**Inventario**
- **Productos** — dos pestañas (Consumibles / Componentes) sobre la misma tabla. Búsqueda por
  nombre, no. de parte, marca y código de barras; en Componentes también por serie y código
  interno. Botón **Imprimir** (etiqueta con código de barras) y, solo en trazables,
  **Movimientos** (historial en modal).
- **Stock por almacén** — solo consulta, agrupado por número de parte. Filtros por almacén, no.
  de parte, nombre, **serie** y estado. `🔍 Ver detalles` abre el desglose de existencias y
  permite reclasificar (cambiar estado/ubicación), fusionando si el destino ya existe.
- **Movimientos** — flujo de 3 pasos: elegir almacén → tickets del almacén → capturar.
  El formulario tiene carrito, casilla de Stock Inicial y cuatro referencias opcionales con
  selector filtrable: **producto activo, equipo, unidad operativa y proveedor**.
  Al guardar se genera el folio y se muestra el ticket, imprimible.

**Catálogos** — Almacenes · Unidades de medida · Estados · Equipos · Proveedores

**Operaciones** — Unidades operativas · Equipos por unidad

## Migraciones

El historial formal en Supabase empieza en `movimientos_ticket`: la `0001` se ejecutó a mano en
el SQL Editor, así que no aparece en `supabase_migrations`. No hay que "recuperarla" — las tablas
existen y el archivo es idempotente.

**La numeración de `supabase/migrations/` tiene huecos** (faltan 0011, 0012, 0015, 0018 y 0023).
Esas migraciones se aplicaron directo a la base vía el MCP de Supabase y nunca quedó el archivo
local. La base es la fuente de verdad; los archivos presentes sí reflejan lo aplicado.

Todas las migraciones son **idempotentes**: pueden re-ejecutarse sin romper nada.

## Notas de diseño

- **Convenciones de nombres**: `activo` (no `active`), sin acentos en identificadores
  (`observacion`, `descripcion`), y `estado_id` para las FK al catálogo `estados`. Postgres pasa
  a minúsculas los identificadores sin comillas — por eso `activoFijo` terminó siendo `activofijo`
  antes de renombrarse a `es_trazable`.
- **`usuarios`** se sincroniza solo al iniciar sesión (enlace `auth_uid` con `auth.users`); no
  tiene pantalla.
- **`movimientos` es un log**: no tiene `activo` ni se edita.
- **RLS**: acceso total para `authenticated`. Se puede granularizar por rol sin tocar el frontend.
- **`equipos` es un catálogo flotante**: `productos.equipos_compatible` guarda los modelos como
  texto, sin FK. Consecuencia asumida: renombrar un modelo en `equipos` no actualiza los
  productos que ya lo referencian.
- **Accesibilidad**: paleta con tokens de tinta (`--*-ink`) para que todo el texto cumpla
  contraste **WCAG AA (4.5:1)** en tema claro y oscuro; foco visible en todo lo interactivo.
- **Rendimiento**: las listas solo resuelven los catálogos de las columnas que muestran, y las
  consultas independientes se lanzan en paralelo.

## Pendientes conocidos

- Aviso abierto del linter de Supabase: *Leaked Password Protection Disabled* (configuración de
  Auth, no tocada por decisión).
- `equipos.unidad_actual` conserva texto antiguo (`Corona`, `TCH`, `Unidad 2`) en equipos que aún
  no tienen asignación en `equipo_unidad_operativa`. Se corrigen solos al crearles una.
- El estado `Operativo` se agregó al catálogo `estados` para no perder datos al convertir el
  estado de las asignaciones a FK; convive con los estados de producto.
- Los flujos con sesión iniciada no están probados de forma automatizada: requieren credenciales.
