// Modal para editar estado y ubicación de una existencia (producto_almacen).
// Para componentes trazables: la existencia es única, así que no hay fusión.
// Escribe por el RPC `cambiar_estado_existencia`, el mismo que usa la vista
// Stock, y el trigger propaga a productos.estado_actual / ubicacion_actual.
import { supabase } from "./supabaseClient.js";
import { mensajeError } from "./crud.js";
import { el, openModal, buildField, readField, toast } from "./ui.js";

export async function abrirCambioEstado({ productoAlmacenId, nombre, estadoActualId, ubicacionActual, onDone }) {
  const { data: estados } = await supabase
    .from("estados").select("id, nombre").eq("activo", true).order("nombre");

  const campos = [
    {
      name: "estado_id", label: "Estado", type: "select",
      options: (estados || []).map((e) => ({ value: e.id, label: e.nombre })),
    },
    { name: "ubicacion", label: "Ubicación", type: "text", placeholder: "Ubicación dentro del almacén…" },
  ];

  const body = el("div", { class: "modal__body" }, [
    el("dl", { class: "ticket__meta" }, [
      el("div", {}, [el("dt", { text: "Componente" }), el("dd", { text: nombre || "—" })]),
    ]),
  ]);

  const entradas = {};
  for (const f of campos) {
    const valor = f.name === "estado_id" ? (estadoActualId ?? "") : (ubicacionActual ?? "");
    const { wrap, input } = buildField(f, valor);
    body.appendChild(wrap);
    entradas[f.name] = input;
  }

  openModal({
    title: "Editar estado y ubicación",
    subtitle: "Se aplica sobre la existencia del componente (producto + almacén).",
    body,
    submitLabel: "Guardar",
    onSubmit: async (cerrar) => {
      const { error } = await supabase.rpc("cambiar_estado_existencia", {
        p_producto_almacen_id: productoAlmacenId,
        p_estado_id: readField(campos[0], entradas.estado_id),
        p_ubicacion: readField(campos[1], entradas.ubicacion),
      });
      if (error) throw new Error(mensajeError(error));
      toast("Estado y ubicación actualizados.", "success");
      cerrar();
      onDone?.();
    },
  });
}
