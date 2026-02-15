import { useEffect, useRef } from 'react';
import { isInputFocused } from '../lib/keyboard';

export function useGlobalKeyboard(navigate: (path: string) => void, openPalette: () => void) {
  const pendingRef = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isInputFocused()) return;
      // Don't trigger on modified keys (except for our Cmd+K which is in the palette hook)
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toLowerCase();

      if (pendingRef.current === 'g') {
        pendingRef.current = null;
        clearTimeout(timeoutRef.current);
        const routes: Record<string, string> = { r: '/restaurants', t: '/trips', a: '/accounts', h: '/', f: '/restaurants?filter=favorites', b: '/restaurants?tab=browse' };
        if (routes[key]) {
          e.preventDefault();
          navigate(routes[key]);
        }
        return;
      }

      if (key === 'g') {
        pendingRef.current = 'g';
        clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => { pendingRef.current = null; }, 1000);
        return;
      }

      if (key === 'c') {
        e.preventDefault();
        navigate('/trips?action=new');
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      clearTimeout(timeoutRef.current);
    };
  }, [navigate, openPalette]);
}
