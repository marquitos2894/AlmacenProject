# Sistema de Gestión de Almacén

SPA en **Vanilla JS** que se conecta directamente a **Supabase** (PostgREST + Auth + RLS).
No hay servidor propio: el navegador habla con Supabase usando `supabase-js`.

## Stack

- **Frontend:** HTML + CSS + JavaScript (ES modules), sin paso de build.
- **Datos/Auth/API:** Supabase (Postgres + PostgREST + Auth + RLS).
- **Librería:** `@supabase/supabase-js` (UMD, servido localmente en `public/vendor/supabase.js`).

## Estructura

```
supabase/migrations/0001_init.sql   Esquema: tablas, FKs, RLS, vistas y seed
public/                             Sitio estático
  index.html
  css/styles.css                   Admin template (claro/oscuro)
  vendor/supabase.js               Bundle UMD de supabase-js
  js/
    config.js                      URL + anon key (RELLENAR)
    supabaseClient.js  auth.js  ui.js  crud.js  app.js
    views/                         Una por pantalla
```

## Puesta en marcha

1. **Crear el esquema.** En el proyecto Supabase → SQL Editor, ejecuta **en orden**:
   1. `supabase/migrations/0001_init.sql` — tablas, RLS, vistas y datos semilla.
   2. `supabase/migrations/0002_movimientos_ticket.sql` — código de barras, movimientos
      maestro-detalle con folio, stock agrupado y la función `registrar_movimiento`.
   3. `supabase/migrations/0003_activo_fijo_unico.sql` — regla de activo fijo.
   4. `supabase/migrations/0004_fijar_search_path.sql` — cierra el aviso de seguridad
      `function_search_path_mutable` del linter de Supabase.
   5. `supabase/migrations/0005_stock_por_estado_ubicacion.sql` — el stock se identifica
      por producto + almacén + estado + ubicación.

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

4. **Refrescar el vendor** (solo si actualizas supabase-js):
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

**Mantenimientos (CRUD, sin borrado físico — solo `activo=false`; las listas muestran solo activos):**
Productos, Unidades de medida, Estados, Equipos, Almacenes.

- En **Productos**, "Equipos compatibles" es un **selector múltiple** (tabla puente `producto_equipo`,
  que además conecta la entidad `EQUIPOS`).
- **Código de barras**: si lo escribes se respeta; si lo dejas vacío la base lo genera como
  `BAR-{no_parte}` (espacios → `_`, con sufijo `-{id}` si ya existe) o `SYS-{id}` si no hay no. de parte.
  Se dibuja con JsBarcode.

**Movimientos — flujo de 3 pasos:**

1. `#/movimientos` — eliges el **almacén** en tarjetas.
2. `#/movimientos/{id}` — tickets de ese almacén, con filtros por no. de parte, nombre y estado.
3. `#/movimientos/{id}/nuevo` — encabezado + **carrito**:
   - **Agregar producto** abre un modal de búsqueda con autocompletado (debounce de 300 ms) sobre
     `no_parte`, `nombre` y `no_serie`, con badge de existencia y alta rápida de productos.
   - **Stock Inicial** (casilla): *reemplaza* la existencia en lugar de sumarla.
   - Al guardar se genera el **folio** `TKT-{AAMMDD}-{####}` y se muestra el ticket con su código de barras.

El guardado usa la función `registrar_movimiento`, que hace encabezado + detalle + ajuste de stock
en **una sola transacción**.

**Stock por almacén — solo consulta.** Agrupado por `no_parte` (la suma la hace SQL, en
`vw_stock_agrupado`), con `🔍 Ver detalles` que abre el desglose de series individuales. El stock ya
**no se edita aquí**: se modifica únicamente registrando movimientos.

## Reglas de negocio

- **Identidad del stock**: una existencia es la combinación **producto + almacén + estado + ubicación**.
  Si registras un movimiento con un estado o una ubicación distintos, **no se suma**: se crea una
  existencia nueva. Lo garantiza el índice `uq_producto_almacen_grano` (con `NULLS NOT DISTINCT`, para
  que dos filas «sin estado» choquen entre sí en lugar de multiplicarse).
- **Ubicación normalizada**: `A-7`, `a-7` y `A-7 ` son la misma ubicación. La columna generada
  `ubicacion_norm` (`upper(btrim(...))`) es la que se indexa; `ubicacion` conserva lo que escribió
  el usuario. Sin esto el almacén se fragmentaría solo.
- **Activo fijo**: un producto con `activofijo = true` solo puede existir en **un almacén** y no puede
  duplicarse (`uq_producto_almacen_activo_fijo`). Como es una unidad física única, cambiarle el estado
  o la ubicación lo **traslada** (actualiza su fila) en vez de crear otra. Moverlo a **otro almacén**
  sigue exigiendo darle salida primero.
- **Salidas**: el renglón identifica la existencia exacta (`producto_almacen_id`), porque un mismo
  producto puede tener varias existencias en el almacén. No hay descuentos automáticos.
- **Stock Inicial** sobrescribe **solo esa existencia**; las demás del mismo producto no se tocan.
  Una entrada normal suma y una salida resta (nunca por debajo de cero).

## Notas de diseño

- `usuarios` se sincroniza solo al iniciar sesión (enlace `auth_uid` con `auth.users`); no tiene pantalla.
- `movimientos` es un log (sin `activo`).
- RLS: acceso total para usuarios `authenticated`. Se puede granularizar por rol sin tocar el frontend.
- La columna `activoFijo` de `productos` se guarda como `activofijo` (Postgres pasa a minúsculas los
  identificadores sin comillas); el frontend usa ese nombre.
- Paleta con tokens de tinta separados (`--*-ink`) para que todo el texto cumpla contraste
  **WCAG AA (4.5:1)** en tema claro y oscuro.
