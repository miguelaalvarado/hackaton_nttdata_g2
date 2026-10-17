import { NextResponse } from "next/server";
import { getService } from "@/lib/container";
import type { ContactAttempt, Proposal } from "@/lib/core/types";

export const maxDuration = 60;

type Body = { clientId: string; proposal: Proposal; history?: ContactAttempt[]; action?: "send" | "review" };

export async function POST(req: Request) {
  try {
    const { clientId, proposal, history = [], action = "send" } = (await req.json()) as Body;
    const svc = getService();
    if (action === "review") return NextResponse.json({ compliance: await svc.review(clientId, proposal, history) });

    // Nunca se envía algo que cumplimiento bloquea, aunque el cliente web lo pida.
    const compliance = await svc.review(clientId, proposal, history);
    if (compliance.status === "block") return NextResponse.json({ error: "Bloqueado por cumplimiento", compliance }, { status: 422 });
    return NextResponse.json(await svc.respond(clientId, proposal, history));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}
