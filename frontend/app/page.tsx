'use client';
import dynamic from 'next/dynamic';

// The shell talks to Electron/IPC, so render it on the client only.
const Shell = dynamic(() => import('@/components/Shell'), { ssr: false });

export default function Page() {
  return <Shell />;
}
