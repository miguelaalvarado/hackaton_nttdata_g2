'use client';
import { COLOR_LABEL, PROFILE_LABEL } from '@/lib/api';
import type { ReactNode } from 'react';

export function ColorBadge({ color }: { color: string }) {
  return <span className={`badge c-${color}`}>{COLOR_LABEL[color] ?? color}</span>;
}

export function ProfileChip({ profile }: { profile: string }) {
  return <span className={`chip p-${profile}`}>{PROFILE_LABEL[profile] ?? profile}</span>;
}

export function Card({ title, children, actions }: { title?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-h">
          <h3>{title}</h3>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Loading() {
  return <p className="muted">Cargando…</p>;
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <p className="error">{error}</p> : null;
}
