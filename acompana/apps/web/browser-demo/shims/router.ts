/** Enrutador en memoria para la versión navegador (sustituye a next/navigation y next/link). */
import { useEffect, useState } from 'react';

type Listener = (path: string) => void;
let current = '/';
const listeners = new Set<Listener>();

export function navigate(path: string, _replace = false) {
  current = path;
  listeners.forEach((l) => l(path));
  window.scrollTo?.(0, 0);
}
export function usePath(): string {
  const [p, setP] = useState(current);
  useEffect(() => {
    const l: Listener = (x) => setP(x);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return p;
}
export function matchParams(path: string): Record<string, string> {
  const m = path.match(/^\/panel\/becario\/([^/?#]+)/);
  return m ? { id: decodeURIComponent(m[1]) } : {};
}
