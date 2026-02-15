import { useState, useRef, useEffect } from 'react';
import * as chrono from 'chrono-node';
import { format, isValid } from 'date-fns';

interface Props {
  value: string; // YYYY-MM-DD
  onChange: (date: string) => void;
  onRangeParsed?: (start: string, end: string) => void;
  label: string;
  required?: boolean;
  placeholder?: string;
  referenceDate?: Date;
  autoFocus?: boolean;
}

function parseDateInput(text: string, refDate?: Date): { start: Date | null; end: Date | null } {
  const trimmed = text.trim();
  if (!trimmed) return { start: null, end: null };

  // Fast path: direct YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed + 'T12:00:00');
    return { start: isValid(d) ? d : null, end: null };
  }

  const results = chrono.parse(trimmed, refDate || new Date());
  if (results.length === 0 || !results[0]) return { start: null, end: null };

  const first = results[0];
  const start = first.start?.date() ?? null;
  const end = first.end?.date() ?? null;
  return { start, end };
}

function formatForDisplay(date: Date): string {
  return format(date, 'EEE, MMM d, yyyy');
}

function formatForApi(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

export default function SmartDateInput({
  value,
  onChange,
  onRangeParsed,
  label,
  required,
  placeholder = 'e.g., may 15',
  referenceDate,
  autoFocus,
}: Props) {
  const [rawText, setRawText] = useState('');
  const [parsedDate, setParsedDate] = useState<Date | null>(null);
  const [parsedEnd, setParsedEnd] = useState<Date | null>(null);
  const [isConfirmed, setIsConfirmed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync display when value is set externally (e.g., range auto-fill)
  useEffect(() => {
    if (value && !isConfirmed) {
      const d = new Date(value + 'T12:00:00');
      if (isValid(d)) {
        setRawText(formatForDisplay(d));
        setParsedDate(d);
        setIsConfirmed(true);
      }
    }
  }, [value]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const handleChange = (text: string) => {
    setRawText(text);
    setIsConfirmed(false);
    const { start, end } = parseDateInput(text, referenceDate);
    setParsedDate(start);
    setParsedEnd(end);
  };

  const confirm = () => {
    if (parsedDate && !isConfirmed) {
      onChange(formatForApi(parsedDate));
      setRawText(formatForDisplay(parsedDate));
      setIsConfirmed(true);

      if (parsedEnd && onRangeParsed) {
        onRangeParsed(formatForApi(parsedDate), formatForApi(parsedEnd));
      }
    } else if (!parsedDate && rawText.trim()) {
      // Can't parse — clear
      setRawText('');
      onChange('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirm();
    }
  };

  const handleFocus = () => {
    if (isConfirmed) {
      inputRef.current?.select();
      setIsConfirmed(false);
    }
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}{required && ' *'}
      </label>
      <input
        ref={inputRef}
        type="text"
        value={rawText}
        onChange={e => handleChange(e.target.value)}
        onBlur={confirm}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
      />
      {!isConfirmed && parsedDate && (
        <div className="mt-1 text-xs text-green-700 bg-green-50 px-2 py-0.5 rounded inline-block animate-fade-in-up">
          &rarr; {formatForDisplay(parsedDate)}
          {parsedEnd && <span className="ml-1">to {formatForDisplay(parsedEnd)}</span>}
        </div>
      )}
      {!isConfirmed && rawText.length > 2 && !parsedDate && (
        <div className="mt-1 text-xs text-gray-400 animate-fade-in-up">
          Could not parse date
        </div>
      )}
    </div>
  );
}
