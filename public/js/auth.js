import { supabase } from "./supabaseClient.js";

let currentUsuario = null; // fila de public.usuarios asociada a la sesión

export function getCurrentUsuario() {
  return currentUsuario;
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  await supabase.auth.signOut();
  currentUsuario = null;
}

// Garantiza una fila en public.usuarios enlazada al usuario de auth.
// Devuelve la fila (o null si falla, sin romper el login).
export async function ensureUsuario(authUser) {
  if (!authUser) return null;
  try {
    // ¿existe ya?
    const { data: existing } = await supabase
      .from("usuarios")
      .select("*")
      .eq("auth_uid", authUser.id)
      .maybeSingle();

    if (existing) {
      currentUsuario = existing;
      return existing;
    }

    const nombre = (authUser.email || "").split("@")[0] || "Usuario";
    const { data: created, error } = await supabase
      .from("usuarios")
      .insert({ auth_uid: authUser.id, email: authUser.email, nombre })
      .select()
      .single();
    if (error) throw error;
    currentUsuario = created;
    return created;
  } catch (e) {
    console.warn("[auth] No se pudo sincronizar el registro de usuario:", e.message);
    return null;
  }
}

// Registra un callback que recibe (session) en cada cambio de estado de auth.
export function onAuthChange(cb) {
  supabase.auth.onAuthStateChange((_event, session) => cb(session));
}
