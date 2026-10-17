/** Borrador dirigido al cliente, con el Supervisor como remitente. */
export function borradorSupervisor(nombre: string): string {
  const primer = nombre.trim().split(/\s+/)[0];
  return `Hola ${primer}, soy el Supervisor de tu banco. He derivado tu caso a un asesor humano para que lo revise contigo. Gracias por contarnos tu situación; queremos ayudarte y cualquier propuesta deberá respetar las condiciones autorizadas.`;
}
