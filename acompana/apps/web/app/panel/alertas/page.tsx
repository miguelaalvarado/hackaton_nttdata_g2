'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, getSession } from '@/lib/api';
import { AlertCard } from '@/components/AlertCard';
import { Loading } from '@/components/ui';

export default function Alerts() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [all, setAll] = useState(false);
  const isCoord = getSession()?.user.role === 'COORDINADOR';
  const load = () => api(`/panel/alerts?status=${all ? 'todas' : 'abiertas'}`).then(setRows);
  useEffect(() => { load(); }, [all]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows) return <Loading />;
  return (
    <>
      <div className="spread">
        <h1>{isCoord ? 'Alertas del equipo' : 'Mis alertas'}</h1>
        <label className="row small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Incluir cerradas</label>
      </div>
      <p className="small muted">Rojas primero. Toda alerta roja debe tener una primera acción humana dentro de 48 horas.</p>
      {rows.length === 0 && <p className="muted">No hay alertas.</p>}
      {rows.slice(0, 80).map((a) => (
        <div key={a.id}>
          <Link href={`/panel/becario/${a.scholarId}`} className="small">Ver ficha de {a.scholarName} →</Link>
          <AlertCard a={a} onChange={load} showScholar />
        </div>
      ))}
    </>
  );
}
