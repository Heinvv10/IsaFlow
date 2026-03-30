/**
 * DescriptionAutocomplete — Description field with auto-suggest dropdown.
 * WS-6.5: Description Templates & Auto-Suggest
 *
 * Debounces input at 300ms, fetches suggestions from /api/accounting/description-suggest,
 * supports keyboard navigation (ArrowUp/Down, Enter, Esc).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { DescriptionSuggestion } from '@/modules/accounting/services/descriptionTemplateService';

interface DescriptionAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  entityType?: string;
  placeholder?: string;
  className?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
}

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

export function DescriptionAutocomplete({
  value,
  onChange,
  entityType,
  placeholder = 'Enter description...',
  className = '',
  id,
  name,
  disabled = false,
}: DescriptionAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<DescriptionSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [fetching, setFetching] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch suggestions with debounce
  const fetchSuggestions = useCallback((query: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (query.trim().length < MIN_QUERY_LENGTH) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setFetching(true);
      try {
        const params = new URLSearchParams({ q: query, limit: '10' });
        if (entityType) params.set('entity_type', entityType);
        const res = await apiFetch(`/api/accounting/description-suggest?${params.toString()}`);
        const json = await res.json() as { data?: { suggestions: DescriptionSuggestion[] } };
        const items = json.data?.suggestions ?? [];
        setSuggestions(items);
        setOpen(items.length > 0);
        setActiveIndex(-1);
      } catch (err) {
        log.warn('Description suggestions fetch failed', { error: err }, 'DescriptionAutocomplete');
        setSuggestions([]);
        setOpen(false);
      } finally {
        setFetching(false);
      }
    }, DEBOUNCE_MS);
  }, [entityType]);

  // Close when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    onChange(newValue);
    fetchSuggestions(newValue);
  }, [onChange, fetchSuggestions]);

  const selectSuggestion = useCallback((text: string) => {
    onChange(text);
    setSuggestions([]);
    setOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  }, [onChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex(i => Math.min(i + 1, suggestions.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex(i => Math.max(i - 1, -1));
        break;
      case 'Enter':
        if (activeIndex >= 0 && suggestions[activeIndex]) {
          e.preventDefault();
          selectSuggestion(suggestions[activeIndex]!.text);
        }
        break;
      case 'Escape':
        setOpen(false);
        setActiveIndex(-1);
        break;
    }
  }, [open, activeIndex, suggestions, selectSuggestion]);

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        id={id}
        name={name}
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (suggestions.length > 0) setOpen(true);
        }}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        className={`w-full ${className}`}
      />

      {/* Loading indicator */}
      {fetching && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          <div className="w-3.5 h-3.5 border-2 border-teal-500/40 border-t-teal-500 rounded-full animate-spin" />
        </div>
      )}

      {/* Dropdown */}
      {open && suggestions.length > 0 && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden">
          <ul role="listbox" className="max-h-52 overflow-y-auto py-1">
            {suggestions.map((s, i) => (
              <li
                key={`${s.source}-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectSuggestion(s.text);
                }}
                onMouseEnter={() => setActiveIndex(i)}
                className={`flex items-center justify-between px-3 py-2 text-sm cursor-pointer transition-colors ${
                  i === activeIndex
                    ? 'bg-teal-50 dark:bg-teal-900/20 text-teal-700 dark:text-teal-300'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                }`}
              >
                <span className="truncate flex-1">{s.text}</span>
                <span className={`ml-2 flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                  s.source === 'template'
                    ? 'bg-teal-100 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
                }`}>
                  {s.source === 'template' ? 'Template' : 'Recent'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
