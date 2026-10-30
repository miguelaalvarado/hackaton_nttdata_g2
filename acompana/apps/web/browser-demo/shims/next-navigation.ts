import { matchParams, navigate, usePath } from './router';

export function useRouter() {
  return { push: (p: string) => navigate(p), replace: (p: string) => navigate(p, true), back: () => navigate('/'), refresh: () => undefined };
}
export function usePathname() {
  return usePath();
}
export function useParams<T extends Record<string, string>>(): T {
  return matchParams(usePath()) as T;
}
