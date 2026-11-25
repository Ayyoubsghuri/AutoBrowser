'use client';
import { bridge } from './bridge';

let base: Promise<{ url: string; token: string }> | null = null;

function conn() {
  if (!base) base = bridge().backend().then((b) => ({ url: `http://127.0.0.1:${b.port}`, token: b.token }));
  return base;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const { url, token } = await conn();
  const res = await fetch(url + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-autobrowser-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? (res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) : null;
  if (!res.ok) throw new Error((data && (data as any).detail) || `${res.status} ${res.statusText}`);
  return data as T;
}

/** Binary download (e.g. .xlsx) as base64, for saving through the desktop bridge. */
export async function getBase64(path: string): Promise<string> {
  const { url, token } = await conn();
  const res = await fetch(url + path, { headers: { 'x-autobrowser-token': token } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Read a local file picked by the user as base64 (for uploads). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',', 2)[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b?: unknown) => api<T>('POST', p, b ?? {});
export const patch = <T = any>(p: string, b: unknown) => api<T>('PATCH', p, b);
export const put = <T = any>(p: string, b: unknown) => api<T>('PUT', p, b);
export const del = <T = any>(p: string) => api<T>('DELETE', p);
