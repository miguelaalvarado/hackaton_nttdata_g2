'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card, Loading } from '@/components/ui';

export default function Kit() {
  const [items, setItems] = useState<any[] | null>(null);
  const load = () => api('/scholar/checklist').then(setItems);
  useEffect(() => { load(); }, []);
  if (!items) return <Loading />;
  const cats = [...new Set(items.map((i) => i.category))];
  return (
    <>
      <h1>Kit de llegada</h1>
      <p className="muted small">Lo básico para tus primeras semanas. Marca lo que ya resolviste.</p>
      {cats.map((c) => (
        <Card key={c} title={c}>
          {items.filter((i) => i.category === c).map((i) => (
            <label key={i.itemId} className="row" style={{ alignItems: 'flex-start', marginBottom: 10 }}>
              <input type="checkbox" checked={Boolean(i.doneAt)} onChange={async (e) => { await api(`/scholar/checklist/${i.itemId}`, { body: { done: e.target.checked } }); load(); }} />
              <span>
                <strong className="small">{i.title}</strong>
                <div className="small muted">{i.detail}</div>
                <div className="small" style={{ color: i.overdue ? 'var(--rojo)' : 'var(--muted)' }}>
                  {i.doneAt ? 'Hecho' : `${i.overdue ? 'Venció' : 'Vence'} el ${new Date(i.dueDate).toLocaleDateString('es-PE')}`}
                </div>
              </span>
            </label>
          ))}
        </Card>
      ))}
    </>
  );
}
