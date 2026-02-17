import { useState, useEffect, useCallback, useMemo } from 'react';

export interface Command {
  id: string;
  label: string;
  keywords?: string[];
  section: string;
  onSelect: () => void;
}

export function useCommandPalette(commands: Command[]) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Global Cmd+K / Ctrl+K listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Reset on open/close
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  // Body scroll lock
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [isOpen]);

  const filteredCommands = useMemo(() => {
    const q = query.toLowerCase().trim();
    const filtered = commands.filter(cmd => {
      // When query is empty, only show Navigation + Actions
      if (!q) return cmd.section === 'Navigation' || cmd.section === 'Actions';
      const haystack = [cmd.label, ...(cmd.keywords || [])].join(' ').toLowerCase();
      return haystack.includes(q);
    });
    return filtered;
  }, [commands, query]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredCommands.length]);

  const close = useCallback(() => setIsOpen(false), []);
  const open = useCallback(() => setIsOpen(true), []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex(i => (i + 1) % (filteredCommands.length || 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex(i => (i - 1 + (filteredCommands.length || 1)) % (filteredCommands.length || 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const cmd = filteredCommands[selectedIndex];
        if (cmd) {
          cmd.onSelect();
          close();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    },
    [filteredCommands, selectedIndex, close],
  );

  return { isOpen, query, setQuery, filteredCommands, selectedIndex, setSelectedIndex, open, close, handleKeyDown };
}
