import { createPortal } from 'react-dom';
import { useRef, useEffect, useCallback } from 'react';
import type { Command } from '../hooks/useCommandPalette';

interface Props {
  query: string;
  setQuery: (q: string) => void;
  filteredCommands: Command[];
  selectedIndex: number;
  setSelectedIndex: (i: number) => void;
  close: () => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
}

function groupBySection(commands: Command[]) {
  const order = ['Navigation', 'Actions', 'Restaurants', 'Trips'];
  const groups: { section: string; commands: Command[] }[] = [];
  const map = new Map<string, Command[]>();
  for (const cmd of commands) {
    let arr = map.get(cmd.section);
    if (!arr) {
      arr = [];
      map.set(cmd.section, arr);
    }
    arr.push(cmd);
  }
  for (const section of order) {
    const cmds = map.get(section);
    if (cmds?.length) groups.push({ section, commands: cmds });
  }
  // Any remaining sections not in the order
  for (const [section, cmds] of map) {
    if (!order.includes(section) && cmds.length) groups.push({ section, commands: cmds });
  }
  return groups;
}

export default function CommandPalette({ query, setQuery, filteredCommands, selectedIndex, setSelectedIndex, close, handleKeyDown }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scroll selected item into view
  const selectedItemRef = useCallback((el: HTMLButtonElement | null) => {
    el?.scrollIntoView({ block: 'nearest' });
  }, []);

  const groups = groupBySection(filteredCommands);

  let flatIndex = -1;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] md:pt-[20vh] px-4" onClick={close}>
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-lg bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center px-4 py-3 border-b border-gray-200">
          <svg className="w-4 h-4 text-gray-400 mr-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or search..."
            className="flex-1 text-sm bg-transparent outline-none placeholder-gray-400"
          />
          <kbd className="ml-2 text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded border border-gray-200">esc</kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-80 overflow-y-auto py-2">
          {filteredCommands.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-400">No results found</div>
          ) : (
            groups.map(group => (
              <div key={group.section}>
                <div className="px-3 py-2 text-xs font-medium text-gray-400 uppercase tracking-wide">
                  {group.section}
                </div>
                {group.commands.map(cmd => {
                  flatIndex++;
                  const idx = flatIndex;
                  const isSelected = idx === selectedIndex;
                  return (
                    <button
                      key={cmd.id}
                      ref={isSelected ? selectedItemRef : undefined}
                      onClick={() => { cmd.onSelect(); close(); }}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      className={`w-full px-3 py-2.5 flex items-center gap-3 text-sm text-left cursor-pointer ${
                        isSelected ? 'bg-blue-50 text-blue-900' : 'text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      {cmd.label}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-gray-100 bg-gray-50 flex items-center gap-4 text-xs text-gray-400">
          <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">↑↓</kbd> navigate</span>
          <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">↵</kbd> select</span>
          <span><kbd className="px-1 py-0.5 bg-gray-200 rounded text-gray-500">esc</kbd> close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
