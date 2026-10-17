import { NextResponse } from "next/server";
import { getService } from "@/lib/container";
import type { ContactAttempt } from "@/lib/core/types";

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { clientId, history = [] } = (await req.json()) as { clientId: string; history?: ContactAttempt[] };
    const svc = getService();
    const result = await svc.propose(clientId, history);
    return NextResponse.json({ ...result, engines: svc.names });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error del agente" }, { status: 500 });
  }
}
