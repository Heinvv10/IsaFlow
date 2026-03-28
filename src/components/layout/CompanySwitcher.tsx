import { useState, useRef, useEffect } from 'react';
import { Building2, ChevronDown, Check, Plus } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';

export function CompanySwitcher() {
  const { activeCompany, companies, switchCompany, loading } = useCompany();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (loading || !activeCompany) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse">
        <div className="w-6 h-6 rounded bg-gray-300 dark:bg-gray-700" />
        <div className="w-24 h-4 rounded bg-gray-300 dark:bg-gray-700 hidden sm:block" />
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors border border-gray-200 dark:border-gray-700"
      >
        {/* Company logo or fallback icon */}
        {activeCompany.logoData ? (
          <img
            src={activeCompany.logoData}
            alt={activeCompany.name}
            className="w-6 h-6 rounded object-contain"
          />
        ) : (
          <div className="w-6 h-6 rounded bg-teal-600 flex items-center justify-center flex-shrink-0">
            <Building2 className="w-3.5 h-3.5 text-white" />
          </div>
        )}

        <span className="text-sm font-medium text-gray-900 dark:text-white truncate max-w-[140px] hidden sm:block">
          {activeCompany.tradingName || activeCompany.name}
        </span>

        <ChevronDown className={`w-3.5 h-3.5 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* Dropdown */}
      {open && companies.length > 0 && (
        <div className="absolute top-full left-0 mt-1 w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700">
            <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Switch Company
            </p>
          </div>

          <div className="max-h-64 overflow-y-auto py-1">
            {companies.map((c) => {
              const isActive = c.companyId === activeCompany.id;
              return (
                <button
                  key={c.companyId}
                  onClick={() => {
                    if (!isActive) {
                      void switchCompany(c.companyId);
                    }
                    setOpen(false);
                  }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                    isActive
                      ? 'bg-teal-50 dark:bg-teal-900/20'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
                  }`}
                >
                  <div className="w-8 h-8 rounded-lg bg-gray-100 dark:bg-gray-700 flex items-center justify-center flex-shrink-0">
                    <Building2 className={`w-4 h-4 ${isActive ? 'text-teal-600' : 'text-gray-500'}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium truncate ${
                      isActive ? 'text-teal-700 dark:text-teal-400' : 'text-gray-900 dark:text-white'
                    }`}>
                      {c.companyName}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 capitalize">{c.role}</p>
                  </div>
                  {isActive && <Check className="w-4 h-4 text-teal-600 flex-shrink-0" />}
                </button>
              );
            })}
          </div>

          <div className="border-t border-gray-100 dark:border-gray-700 p-2">
            <a
              href="/accounting/company-settings"
              className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded-lg transition-colors"
              onClick={() => setOpen(false)}
            >
              <Plus className="w-4 h-4" />
              <span>Manage Companies</span>
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
