/**
 * Client Portal — Dashboard
 * Customer self-service: view invoices, statements, make payments
 */

import { useState, useEffect } from 'react';
import { BookOpen, FileText, CreditCard, LogOut, Loader2 } from 'lucide-react';
import Head from 'next/head';

function formatCurrency(amount: number): string {
  return 'R ' + Math.abs(amount).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface PortalUser {
  id: string;
  clientId: string;
  email: string;
  name: string;
}

interface PortalInvoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  total: number;
  amountPaid: number;
  balance: number;
  status: string;
}

const STATUS_STYLES: Record<string, string> = {
  sent: 'bg-blue-500/20 text-blue-500',
  overdue: 'bg-red-500/20 text-red-500',
  paid: 'bg-teal-500/20 text-teal-500',
  partial: 'bg-amber-500/20 text-amber-500',
};

export default function PortalPage() {
  const [user, setUser] = useState<PortalUser | null>(null);
  const [invoices, setInvoices] = useState<PortalInvoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  const handleLogin = async () => {
    setLoggingIn(true);
    setLoginError('');
    try {
      const res = await fetch('/api/portal/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      });
      const json = await res.json();
      if (!res.ok || !json.data?.user) {
        setLoginError(json.error?.message || 'Invalid credentials');
        return;
      }
      setUser(json.data.user);
      localStorage.setItem('portal_user', JSON.stringify(json.data.user));
    } catch {
      setLoginError('Login failed');
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = () => {
    setUser(null);
    setInvoices([]);
    localStorage.removeItem('portal_user');
  };

  useEffect(() => {
    const saved = localStorage.getItem('portal_user');
    if (saved) {
      try { setUser(JSON.parse(saved)); } catch { /* ignore */ }
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    fetch(`/api/portal/invoices?clientId=${user.clientId}`)
      .then(r => r.json())
      .then(json => setInvoices(json.data?.items ?? []))
      .catch(() => { /* invoice load failure — non-critical, UI shows empty invoice list */ })
      .finally(() => setLoading(false));
  }, [user]);

  const totalOutstanding = invoices.reduce((s, inv) => s + inv.balance, 0);
  const overdueInvoices = invoices.filter(inv => inv.status === 'overdue');

  if (!user) {
    return (
      <>
        <Head><title>IsaFlow — Client Portal</title></Head>
        <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
          <div className="w-full max-w-sm">
            <div className="flex flex-col items-center mb-8">
              <div className="w-12 h-12 bg-teal-600 rounded-xl flex items-center justify-center mb-3">
                <BookOpen className="w-6 h-6 text-white" />
              </div>
              <h1 className="text-xl font-semibold text-white">IsaFlow Portal</h1>
              <p className="text-sm text-gray-500 mt-1">Sign in to view your account</p>
            </div>
            <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 shadow-xl">
              {loginError && (
                <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                  {loginError}
                </div>
              )}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-300 mb-1">Email</label>
                <input
                  type="email"
                  value={loginEmail}
                  onChange={e => setLoginEmail(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                  placeholder="you@company.com"
                />
              </div>
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-300 mb-1">Password</label>
                <input
                  type="password"
                  value={loginPassword}
                  onChange={e => setLoginPassword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && void handleLogin()}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                  placeholder="Enter your password"
                />
              </div>
              <button
                onClick={() => void handleLogin()}
                disabled={loggingIn || !loginEmail || !loginPassword}
                className="w-full bg-teal-600 hover:bg-teal-500 disabled:bg-teal-800 text-white font-medium text-sm px-4 py-2.5 rounded-lg transition-colors disabled:cursor-not-allowed"
              >
                {loggingIn ? 'Signing in...' : 'Sign in'}
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Head><title>IsaFlow — {user.name}</title></Head>
      <div className="min-h-screen bg-gray-950">
        {/* Header */}
        <header className="bg-gray-900 border-b border-gray-700 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-teal-600 rounded-lg flex items-center justify-center">
              <BookOpen className="w-4 h-4 text-white" />
            </div>
            <span className="font-semibold text-teal-400 text-sm">IsaFlow Portal</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-400">{user.name}</span>
            <button onClick={handleLogout} className="text-gray-400 hover:text-white transition-colors">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="max-w-5xl mx-auto p-6 space-y-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">Total Outstanding</p>
              <p className="text-2xl font-bold text-white">{formatCurrency(totalOutstanding)}</p>
            </div>
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">Invoices</p>
              <p className="text-2xl font-bold text-white">{invoices.length}</p>
            </div>
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">Overdue</p>
              <p className={`text-2xl font-bold ${overdueInvoices.length > 0 ? 'text-red-400' : 'text-teal-400'}`}>
                {overdueInvoices.length}
              </p>
            </div>
          </div>

          {/* Invoices Table */}
          <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-700 flex items-center gap-2">
              <FileText className="h-5 w-5 text-gray-400" />
              <h2 className="text-lg font-semibold text-white">Your Invoices</h2>
            </div>
            {loading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
              </div>
            ) : invoices.length === 0 ? (
              <div className="px-6 py-12 text-center text-gray-500">No invoices found</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-800/50">
                    <th className="text-left px-6 py-3 font-medium text-gray-400">Invoice #</th>
                    <th className="text-left px-6 py-3 font-medium text-gray-400">Date</th>
                    <th className="text-left px-6 py-3 font-medium text-gray-400">Due Date</th>
                    <th className="text-right px-6 py-3 font-medium text-gray-400">Total</th>
                    <th className="text-right px-6 py-3 font-medium text-gray-400">Balance</th>
                    <th className="text-center px-6 py-3 font-medium text-gray-400">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {invoices.map(inv => (
                    <tr key={inv.id} className="hover:bg-gray-800/30">
                      <td className="px-6 py-3 text-white font-medium">{inv.invoiceNumber}</td>
                      <td className="px-6 py-3 text-gray-300">{new Date(inv.invoiceDate).toLocaleDateString('en-ZA')}</td>
                      <td className="px-6 py-3 text-gray-300">{new Date(inv.dueDate).toLocaleDateString('en-ZA')}</td>
                      <td className="px-6 py-3 text-right text-gray-300">{formatCurrency(inv.total)}</td>
                      <td className={`px-6 py-3 text-right font-medium ${inv.balance > 0 ? 'text-amber-400' : 'text-teal-400'}`}>
                        {formatCurrency(inv.balance)}
                      </td>
                      <td className="px-6 py-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[inv.status] || 'bg-gray-500/20 text-gray-400'}`}>
                          {inv.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
