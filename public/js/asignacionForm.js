// Formularios de asignación de un equipo a un establecimiento (tabla
// `equipo_unidad_operativa`, un historial: la fila sin fecha de fin es la
// asignación vigente, y la base impide dos abiertas a la vez).
//
// Se parten en tres para que la interfaz no permita abrir una asignación
// mientras haya una vigente:
//   - cfgAbrirAsignacion  → alta de una asignación nueva (solo si no hay vigente)
//   - cfgCerrarAsignacion → poner fecha de fin a la asignación vigente
//   - cfgEditarAsignacion → corregir código asignado / fecha de inicio / estado
//
// Las tres las consume `openForm` (crud.js) con `.insert()` / `.update()`
// directos sobre `equipo_unidad_operativa`.

const hoy = () => new Date().toISOString().slice(0, 10);

// --- Definiciones de campo reutilizables ------------------------------------
const campoEquipo = (equipo) => ({
  name: "equipo_id", label: "Equipo", type: "select", required: true,
  disabled: true, default: equipo?.id ?? null,
  source: {
    table: "vw_equipos_lista", value: "id", label: "modelo",
    labelFn: (r) => r.etiqueta || [r.modelo, r.no_serie].filter(Boolean).join("/"),
  },
});

const campoEstablecimiento = ({ disabled = false } = {}) => ({
  name: "unidad_operativa_id", label: "Establecimiento", type: "select", required: true,
  disabled,
  source: {
    table: "unidad_operativa", value: "id", label: "nombre",
    labelFn: (r) => [r.codigo, r.nombre].filter(Boolean).join(" · "),
  },
});

const campoCodigoAsignado = {
  name: "codigo_asignado", label: "Código asignado", type: "text",
  placeholder: "No. de flota, código interno del proyecto…",
  hint: "El código que lleva el equipo en ese establecimiento. No puede repetirse entre asignaciones vigentes del mismo establecimiento.",
};

const campoEstado = {
  name: "estado_id", label: "Estado", type: "select",
  source: { table: "estados", value: "id", label: "nombre" },
  hint: "El equipo hereda este estado como su estado actual.",
};

const campoObservacion = { name: "observacion", label: "Observación", type: "textarea" };

const BASE = { table: "equipo_unidad_operativa", singular: "asignación de equipo", touchUpdatedAt: true };

// --- Abrir: alta de una asignación nueva -----------------------------------
export function cfgAbrirAsignacion(equipo) {
  return {
    ...BASE,
    formTitle: "Nueva asignación de equipo",
    submitLabel: "Abrir asignación",
    fields: [
      campoEquipo(equipo),
      campoEstablecimiento(),
      campoCodigoAsignado,
      { name: "fecha_inicio", label: "Fecha de inicio", type: "date", required: true, default: hoy() },
      {
        name: "horometro_inicial", label: "Horómetro inicial", type: "number",
        placeholder: "Lectura al asignar",
        hint: "Horas de la máquina al entrar a ese establecimiento. Opcional.",
      },
      campoEstado,
      campoObservacion,
    ],
  };
}

// --- Cerrar: poner fecha de fin a la asignación vigente -------------------
// Se abre con `openForm(cfg, { ...vigente, fecha_fin: hoy() }, ...)`.
export function cfgCerrarAsignacion(equipo) {
  return {
    ...BASE,
    formTitle: "Cerrar asignación de equipo",
    submitLabel: "Cerrar asignación",
    fields: [
      campoEquipo(equipo),
      campoEstablecimiento({ disabled: true }),
      campoCodigoAsignado,
      { name: "fecha_fin", label: "Fecha de fin", type: "date", required: true },
      {
        name: "horometro_final", label: "Horómetro final", type: "number",
        placeholder: "Lectura al cerrar",
        hint: "Horas de la máquina al terminar. No puede ser menor que el inicial.",
      },
      campoEstado,
      campoObservacion,
    ],
  };
}

// --- Editar: solo código asignado, fecha de inicio y estado --------------
export function cfgEditarAsignacion(equipo) {
  return {
    ...BASE,
    formTitle: "Editar asignación de equipo",
    submitLabel: "Guardar cambios",
    fields: [
      campoEquipo(equipo),
      campoEstablecimiento({ disabled: true }),
      campoCodigoAsignado,
      { name: "fecha_inicio", label: "Fecha de inicio", type: "date", required: true },
      campoEstado,
    ],
  };
}
