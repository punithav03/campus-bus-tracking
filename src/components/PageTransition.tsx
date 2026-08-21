'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/**
 * Cross-fades page content on navigation.
 *
 * Not the View Transitions API: that is built for cross-document navigation or
 * a synchronous DOM swap, and Next's client router gives neither — driving it
 * from a route change means either a flash or a hack. A keyed CSS animation
 * produces the same perceived result, works in every browser, and cannot break.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [key, setKey] = useState(pathname);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setKey(pathname);
  }, [pathname]);

  return (
    <div key={key} className="page-swap">
      {children}
    </div>
  );
}
