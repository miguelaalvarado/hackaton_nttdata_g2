/** 98•••••85: el número completo no sale por la API. */
export const enmascararCelular = (c: string) => (c.length <= 4 ? "••••" : `${c.slice(0, 2)}${"•".repeat(Math.max(c.length - 4, 3))}${c.slice(-2)}`);
