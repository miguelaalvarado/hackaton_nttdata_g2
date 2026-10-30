'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, getSession, PROFILE_LABEL } from '@/lib/api';
import { Card, ColorBadge, Loading, ProfileChip } from '@/components/ui';

export default function Panel() {
  const [ov, setOv] = useState<any>(null);
  const [rows, setRows] = useState<any[] | null>(null);
  const [filter, setFilter] = useState({ color: '', profile: '', q: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const isCoord = getSession()?.user.role === 'COORDINADOR';

  const load = () => {
    api('/panel/overview').then(setOv);
    const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
    api(`/panel/scholars?${qs}`).then(setRows);
  };
  useEffect(load, [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  async function advance() {
    setBusy('Avanzando una semana y recalculando…');
    await api('/panel/demo/advance-week', { body: {} });
    setBusy(null);
    load();
  }

  if (!ov) return <Loading />;
  const sla = ov.sla48;
  return (
    <>
      <div className="spread">
        <div>
          <h1>Panel de acompañamiento</h1>
          <p className="muted small" style={{ marginTop: 0 }}>Semana {ov.week.weekNumber} del ciclo (desde {ov.week.weekStart}) · {ov.scholars} becarios en tu alcance</p>
        </div>
        {isCoord && (
          <button className="secondary" onClick={advance} disabled={Boolean(busy)} title="Solo demo: simula una semana más">
            {busy ?? 'Demo: avanzar una semana'}
          </button>
        )}
      </div>

      <div className="grid g4">
        {(['ROJO', 'AMARILLO', 'VERDE'] as const).map((c) => (
          <button key={c} className="card secondary" style={{ textAlign: 'left', color: 'inherit' }} onClick={() => setFilter({ ...filter, color: filter.color === c ? '' : c })}>
            <ColorBadge color={c} />
            <div className="stat">{ov.byColor[c]}</div>
            <div className="small muted">{filter.color === c ? 'Filtrando · clic para quitar' : 'Clic para filtrar'}</div>
          </button>
        ))}
        <div className="card">
          <strong className="small">Alertas abiertas</strong>
          <div className="stat">{ov.alerts.open}</div>
          <div className="small muted">{ov.alerts.openRed} rojas · {ov.alerts.openYellow} amarillas</div>
        </div>
        <div className="card">
          <strong className="small">Rojas atendidas en 48 h</strong>
          <div className="stat">{sla.complianceRate === null ? '—' : `${Math.round(sla.complianceRate * 100)}%`}</div>
          <div className="small muted">{sla.CUMPLIDA} a tiempo · {sla.INCUMPLIDA} tarde · {sla.VENCIDA} vencidas · {sla.EN_PLAZO} en plazo</div>
        </div>
      </div>

      <Card title="Perfiles de la semana">
        <div className="row">
          {Object.entries(ov.byProfile).sort((a: any, b: any) => b[1] - a[1]).map(([p, n]: any) => (
            <button key={p} className={filter.profile === p ? '' : 'secondary'} onClick={() => setFilter({ ...filter, profile: filter.profile === p ? '' : p })}>
              {PROFILE_LABEL[p] ?? p}: {n}
            </button>
          ))}
        </div>
      </Card>

      <Card title="Becarios" actions={<input placeholder="Buscar por nombre" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />}>
        {!rows ? <Loading /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Becario</th><th>Color</th><th>Perfiles</th><th>Razón principal</th><th className="hide-sm">Cohorte</th><th>Alertas</th></tr>
              </thead>
              <tbody>
                {rows.slice(0, 150).map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/panel/becario/${r.id}`}><strong>{r.name}</strong></Link>
                      {r.persona && <span className="chip">demo</span>}
                      <div className="small muted">{r.career} · {r.university}</div>
                    </td>
                    <td><ColorBadge color={r.color} /></td>
                    <td>{r.profiles.map((p: string) => <ProfileChip key={p} profile={p} />)}</td>
                    <td className="small">{r.topReason ?? '—'}</td>
                    <td className="small hide-sm">{r.cohort === 'NUEVO_DS017' ? 'Nueva (DS 017)' : 'Anterior'}</td>
                    <td>{r.openAlerts || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 150 && <p className="small muted">Mostrando 150 de {rows.length}. Usa los filtros.</p>}
          </div>
        )}
      </Card>

      <p className="small muted">
        Modelo: {ov.model.version} (AUC {ov.model.metrics?.auc?.toFixed(2)}). {ov.model.note} El semáforo no usa región de origen, lengua ni pobreza.
      </p>
    </>
  );
}
