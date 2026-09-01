// Config del formulario de asignación de un equipo a una unidad operativa.
// La vista Equipos la pasa a `openForm` (crud.js) para crear y editar
// asignaciones; la tabla `equipo_unidad_operativa` es un historial (una fila
// sin fecha de fin es la asignación vigente, y la base impide que un mismo
// equipo tenga dos abiertas a la vez).
export const asignacionConfig = {
  table: "equipo_unidad_operativa",
  title: "Equipos por unidad operativa",
  singular: "asignación de equipo",
  touchUpdatedAt: true,
  fields: [
    {
      name: "equipo_id", label: "Equipo", type: "select", required: true,
      source: {
        table: "vw_equipos_lista", value: "id", label: "modelo",
        // "modelo/serie/código asignado" (la vista ya arma la etiqueta).
        labelFn: (r) => r.etiqueta || [r.modelo, r.no_serie].filter(Boolean).join("/"),
      },
    },
    {
      name: "unidad_operativa_id", label: "Unidad operativa", type: "select", required: true,
      source: {
        table: "unidad_operativa", value: "id", label: "nombre",
        labelFn: (r) => [r.codigo, r.nombre].filter(Boolean).join(" · "),
      },
    },
    {
      name: "codigo_asignado", label: "Código asignado", type: "text",
      placeholder: "No. de flota, código interno del proyecto…",
      hint: "El código que lleva el equipo mientras está en esa unidad. No puede repetirse entre asignaciones vigentes de la misma unidad.",
    },
    { name: "fecha_inicio", label: "Fecha de inicio", type: "date", required: true },
    {
      name: "horometro_inicial", label: "Horómetro inicial", type: "number",
      placeholder: "Lectura al asignar",
      hint: "Horas de la máquina al entrar a esta unidad. Opcional.",
    },
    {
      name: "fecha_fin", label: "Fecha de fin", type: "date",
      hint: "Déjala vacía mientras el equipo siga en esa unidad.",
    },
    {
      name: "horometro_final", label: "Horómetro final", type: "number",
      placeholder: "Lectura al cerrar",
      hint: "Horas de la máquina al terminar la asignación. No puede ser menor que el inicial.",
    },
    {
      name: "estado_id", label: "Estado", type: "select",
      source: { table: "estados", value: "id", label: "nombre" },
      hint: "El equipo hereda este estado como su estado actual.",
    },
    { name: "observacion", label: "Observación", type: "textarea" },
  ],
};
