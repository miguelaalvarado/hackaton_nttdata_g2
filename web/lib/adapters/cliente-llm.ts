import type { ClienteSimulator } from "../core/ports";
import { FAST_MODEL, chatModel } from "./llm";

const ESCENARIO: Record<string, string> = {
  retraso_ingresos: "Tu sueldo llegó tarde este mes; te pagan el día {dia} de cada mes. Si te ofrecen mover la fecha de pago unos días hasta después de que cobres, aceptas y prometes un día concreto.",
  iliquidez: "Este mes estás corto de dinero (gastos imprevistos) y tu saldo no alcanza para la cuota completa. Si te ofrecen pagar en 2 partes, aceptas; un simple recordatorio no te basta.",
  olvido: "Simplemente se te pasó la fecha. Si te lo recuerdan, te disculpas y prometes pagar hoy mismo.",
  desempleo: "Perdiste tu trabajo hace poco y no tienes ingresos. Estás preocupado. No aceptas planes de bots; con un asesor humano empático y una propuesta realista de plan, te muestras dispuesto a comprometerte a pagar una cuota pequeña en unas semanas.",
  reclamo: "Crees que el cobro es indebido (cargos que no reconoces). Estás molesto y quieres hacer un reclamo. Con un asesor humano que escuche y ofrezca revisar el caso, te calmas y aceptas pagar el monto correcto una vez aclarado, con fecha concreta.",
  desconoce_deuda: "Dices que no reconoces esta deuda. Niegas haberla contratado. Con un asesor humano que ofrezca verificar los datos, aceptas esperar la verificación y prometes pagar si resulta ser tuya, con fecha concreta.",
};

/** Cliente simulado con LLM, guiado por un escenario oculto; reacciona a lo que realmente le dicen. */
export function clienteLlm(model = FAST_MODEL): ClienteSimulator {
  const m = chatModel(model, 0.7);
  return {
    name: `llm:${model}`,
    async responder({ cliente, historial, ultimoMensaje, deHumano, hoy }) {
      const guion = (ESCENARIO[cliente.sim_escenario] ?? ESCENARIO.olvido).replace("{dia}", String(cliente.dia_abono_sueldo));
      const conv = historial.map((t) => `${t.rol === "cliente" ? "TÚ" : t.rol === "humano" ? "ASESOR" : "BANCO"}: ${t.texto}`).join("\n");
      for (let intento = 0; intento < 3; intento++) {
        const texto = await generar();
        if (texto) return texto;
      }
      return "(sin respuesta)";

      async function generar() {
      const res = await m.invoke([
        {
          role: "system",
          content:
            `Interpretas a ${cliente.nombre}, cliente de un banco con una deuda de ${cliente.producto} (cuota S/ ${cliente.monto_cuota}). Hoy es ${hoy}.\n` +
            `Tu situación real (no la reveles de golpe; cuéntala cuando te pregunten por qué no pagaste): ${guion}\n` +
            `Responde en 1-2 frases, en español coloquial peruano, como en un chat. Si aceptas, di el monto y la fecha concreta (YYYY-MM-DD o "el 30"). ` +
            `Reacciona a lo que te ofrecen realmente: si la oferta no encaja con tu situación, dilo.` +
            (deHumano ? " Quien te escribe ahora es una persona (asesor), no un bot." : ""),
        },
        { role: "user", content: `Conversación:\n${conv}\n\nÚltimo mensaje ${deHumano ? "del asesor" : "del banco"}: """${ultimoMensaje}"""\nTu respuesta:` },
      ]);
      return String(res.content ?? "").trim();
      }
    },
  };
}
