import { useState, useEffect, useRef } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import Image from 'next/image';
import {
  BookOpen, ChevronRight, Check, Star, ArrowRight, Menu, X,
  BarChart3, Receipt, Building2, Landmark, Shield, Zap,
  FileText, Users, CreditCard, PieChart, Globe, Lock,
  Calculator, TrendingUp, Banknote, ClipboardCheck,
  Brain, Smartphone, ChevronDown, PlayCircle,
  BadgeCheck, Layers, RefreshCw, FileSearch,
  Package, Workflow, GitMerge, Briefcase,
  Warehouse, ScanLine, Bot, LineChart,
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Landing page for ISAFlow Accounting                                */
/* ------------------------------------------------------------------ */

const APP_URL = 'https://app.isaflow.co.za';

const FEATURES = [
  { icon: BookOpen, title: 'General Ledger', desc: 'Double-entry bookkeeping with hierarchical chart of accounts, journal entries, recurring journals, cost centres, and multi-currency support.' },
  { icon: Receipt, title: 'Invoicing & AR', desc: 'Professional tax invoices, quotes, sales orders, recurring billing, credit notes, customer statements, and automated dunning.' },
  { icon: CreditCard, title: 'Accounts Payable', desc: 'Supplier invoices with 3-way matching, purchase orders, batch payments, EFT generation for all major SA banks.' },
  { icon: Landmark, title: 'Bank Reconciliation', desc: 'Import statements from FNB, Standard Bank, Nedbank, ABSA, and Capitec. 4-tier smart auto-matching with AI categorisation.' },
  { icon: Calculator, title: 'VAT & SARS', desc: 'Full VAT compliance including standard, zero-rated, exempt, and DRC VAT. VAT201, EMP201, compliance calendar, and submission tracking.' },
  { icon: BarChart3, title: '30+ Financial Reports', desc: 'Income Statement, Balance Sheet, Cash Flow, Trial Balance, Budget vs Actual, Trend Analysis, Waterfall Charts, and executive dashboards.' },
  { icon: Banknote, title: 'Payroll', desc: 'SA payroll with automatic PAYE, UIF, and SDL calculations. Payslip PDFs, IRP5 certificates, and GL auto-posting.' },
  { icon: Brain, title: 'AI Document Capture', desc: 'Vision AI extracts data from receipts, invoices, and contracts. Auto-creates invoices and journal entries with confidence scoring.' },
  { icon: Bot, title: 'Smart Categorisation', desc: 'AI-powered transaction categorisation with rules, 50+ SA merchant patterns, and machine learning. Anomaly detection built in.' },
  { icon: Briefcase, title: 'Fixed Assets', desc: 'Asset register with SARS wear-and-tear categories, depreciation scheduling, disposal tracking, and GL posting.' },
  { icon: Warehouse, title: 'Inventory', desc: 'Stock tracking with items, products, stock adjustments, pricing management, and movement reporting.' },
  { icon: LineChart, title: 'AI Analytics', desc: 'AI-generated management commentary, KPI scorecards, 3-way forecasting, ratio trends, and natural language queries.' },
  { icon: ClipboardCheck, title: 'Approval Workflows', desc: 'Configurable approval rules by document type and amount threshold. Multi-stage chains with full audit trail.' },
  { icon: GitMerge, title: 'Group Consolidation', desc: 'Multi-company management with consolidated reporting, intercompany transactions, and elimination adjustments.' },
  { icon: Globe, title: 'Customer Portal', desc: 'Self-service portal for customers to view invoices, download statements, make payments, and chat with support.' },
  { icon: ScanLine, title: 'Sage Migration', desc: 'Guided migration wizard to import chart of accounts, customers, suppliers, invoices, and opening balances from Sage.' },
];

const DETAILED_FEATURES = [
  {
    badge: 'Core Accounting',
    title: 'Enterprise-grade General Ledger',
    desc: 'ISAFlow\'s double-entry general ledger provides a rock-solid foundation for your accounting. Multi-level chart of accounts, automated journal entries from all modules, fiscal period management, and real-time balance tracking.',
    bullets: ['Hierarchical chart of accounts with 57+ default accounts', 'Auto-balanced journal entries enforced by database triggers', 'Cost centres & business units for dimensional reporting', 'Multi-currency with exchange rate management', 'Recurring journal templates', 'Opening balances & year-end closing'],
    imgKey: 'general-ledger',
  },
  {
    badge: 'Accounts Receivable',
    title: 'Get paid faster with smart invoicing',
    desc: 'Create professional tax invoices, set up recurring billing, and track every rand. Automated dunning keeps your cash flow healthy while the customer portal gives clients self-service access.',
    bullets: ['Professional invoice PDF generation & email delivery', 'Quotes → Sales Orders → Invoices workflow', 'Recurring invoices with flexible schedules', 'Credit notes, write-offs & payment allocation', 'Customer statements & batch statement runs', 'AR aging analysis with debtors manager dashboard'],
    imgKey: 'invoicing',
  },
  {
    badge: 'Banking',
    title: 'Bank reconciliation on autopilot',
    desc: 'Import statements from FNB, Standard Bank, Nedbank, ABSA, Capitec, or any OFX/QIF file. Our 4-tier smart matching engine automatically categorises and reconciles transactions with confidence scoring.',
    bullets: ['7+ bank statement formats supported', '4-tier auto-matching (rules → reference → amount+date → AI)', 'AI-powered smart categorisation with anomaly detection', 'Categorisation rules engine with live preview', 'Bank feeds via Stitch.money for real-time sync', 'Batch payments with EFT file generation for all major SA banks'],
    imgKey: 'banking',
  },
  {
    badge: 'AI-Powered',
    title: 'Intelligence built into every workflow',
    desc: 'ISAFlow uses Vision AI and machine learning to automate tedious accounting tasks. Capture a receipt, and watch it become a journal entry. Upload a supplier invoice, and it auto-matches to your purchase order.',
    bullets: ['Vision AI document extraction (receipts, invoices, contracts)', 'Auto-invoice creation from captured documents', '3-way matching: PO + delivery note + invoice', 'AI-generated management commentary on financials', 'Natural language queries against your data', 'Continuous close automation with smart categorisation'],
    imgKey: 'ai-features',
  },
  {
    badge: 'Tax Compliance',
    title: 'SARS-ready from day one',
    desc: 'Built specifically for South African tax compliance. Automatic VAT calculations on every transaction, VAT201 return generation, EMP201 payroll submissions, and a compliance calendar to never miss a deadline.',
    bullets: ['9 VAT types (standard 15%, zero-rated, exempt, DRC, etc.)', 'VAT201 return auto-generation', 'EMP201 employee tax returns with IRP5 certificates', 'SARS submission tracking with full history', 'Compliance calendar with alerts for due dates', 'DRC VAT support for qualifying transactions'],
    imgKey: 'sars',
  },
  {
    badge: 'Analytics & Reporting',
    title: '30+ reports with executive dashboards',
    desc: 'From trial balances to AI-powered 3-way forecasts, ISAFlow gives you the insights you need. Executive dashboards, KPI scorecards, waterfall charts, trend analysis, and management packs — all exportable to PDF and CSV.',
    bullets: ['Income Statement, Balance Sheet, Cash Flow, Trial Balance', 'Budget vs Actual with variance analysis', '3-way forecast (P&L + Balance Sheet + Cash Flow)', 'KPI scorecard with traffic-light scoring', 'Waterfall charts and trend analysis', 'Report packs for board, management, and monthly reviews'],
    imgKey: 'reports',
  },
];

const PRICING_TIERS = [
  {
    name: 'Starter',
    price: 'R 499',
    period: '/month',
    desc: 'Perfect for sole proprietors and small businesses just getting started.',
    features: [
      'Full General Ledger',
      'Invoicing, Quotes & Statements',
      'Bank Reconciliation (1 bank)',
      'VAT Returns & SARS Compliance',
      '10 Financial Reports',
      'Inventory & Items',
      'Up to 2 users',
      'Email support',
    ],
    cta: 'Start Free Trial',
    popular: false,
  },
  {
    name: 'Professional',
    price: 'R 999',
    period: '/month',
    desc: 'For growing businesses that need full accounting power and automation.',
    features: [
      'Everything in Starter, plus:',
      'Unlimited bank accounts & bank feeds',
      'AI Smart Categorisation & Anomaly Detection',
      'AI Document Capture (Vision AI)',
      'Recurring Invoices & Journals',
      'Batch Payments & EFT Generation',
      'All 30+ Reports & Executive Dashboard',
      'Customer Portal',
      'Fixed Assets & Depreciation',
      'Approval Workflows',
      'Up to 10 users',
      'Priority support',
    ],
    cta: 'Start Free Trial',
    popular: true,
  },
  {
    name: 'Enterprise',
    price: 'R 2,499',
    period: '/month',
    desc: 'For accounting firms and multi-entity businesses with advanced needs.',
    features: [
      'Everything in Professional, plus:',
      'Multi-entity / Group Consolidation',
      'Payroll with PAYE/UIF/SDL & IRP5',
      'SARS eFiling (VAT201 + EMP201)',
      'AI Management Commentary & Forecasting',
      '3-Way Forecast (P&L + BS + Cash Flow)',
      'Cost Centres & Business Units',
      'Budget Management',
      'Sage Migration Wizard',
      'Continuous Close Automation',
      'Unlimited users',
      'Dedicated account manager',
    ],
    cta: 'Contact Sales',
    popular: false,
  },
];

const TESTIMONIALS = [
  { name: 'Thandi Molefe', role: 'CFO, TechBridge Solutions', quote: 'ISAFlow has transformed how we handle our accounting. The bank reconciliation alone saves us 15 hours a month. The SARS compliance features give us peace of mind.', stars: 5 },
  { name: 'Johan van der Merwe', role: 'Owner, VDM Construction', quote: 'Migrating from Sage was seamless. The smart categorisation learns our patterns and now auto-allocates 90% of our bank transactions. Incredible time saver.', stars: 5 },
  { name: 'Priya Naidoo', role: 'Practice Manager, Naidoo & Associates', quote: 'Managing multiple client entities is effortless with ISAFlow. The approval workflows and audit trail give our clients confidence in our processes.', stars: 5 },
];

const FAQ_ITEMS = [
  { q: 'Is ISAFlow SARS-compliant?', a: 'Yes. ISAFlow is built from the ground up for South African tax compliance. It supports all VAT types (standard 15%, zero-rated, exempt, DRC), generates VAT201 and EMP201 returns, tracks SARS submission deadlines, and maintains full audit trails.' },
  { q: 'Can I import data from Sage or other systems?', a: 'Absolutely. ISAFlow includes a dedicated Sage Migration tool that imports your chart of accounts, ledger transactions, customer invoices, and supplier invoices. Pre/post-migration reconciliation ensures nothing is missed.' },
  { q: 'Which banks are supported for statement import?', a: 'ISAFlow supports statement imports from FNB, Standard Bank, Nedbank, ABSA, and Capitec in CSV format, plus OFX, QIF, and PDF formats for other banks. Bank feeds via Stitch.money provide automatic transaction syncing.' },
  { q: 'How does the smart categorisation work?', a: 'Our AI engine uses a multi-strategy approach: first checking your custom rules, then matching against 50+ pre-seeded SA merchant patterns, and finally learning from your historical categorisation decisions. Each suggestion comes with a confidence score so you always know how reliable it is.' },
  { q: 'Is my data secure?', a: 'Your data is stored in Neon PostgreSQL with enterprise-grade encryption. All connections use SSL/TLS, passwords are hashed with bcrypt, and sessions are managed via signed JWT tokens. The application includes security headers against clickjacking, XSS, and other OWASP threats.' },
  { q: 'Can I try ISAFlow for free?', a: 'Yes! Every plan comes with a 14-day free trial — no credit card required. You get full access to all features in your selected tier so you can evaluate ISAFlow with your real data before committing.' },
];

const STATS = [
  { value: '30+', label: 'Financial Reports' },
  { value: '163', label: 'Feature Pages' },
  { value: '91', label: 'Business Services' },
  { value: '99.9%', label: 'Uptime SLA' },
];

export default function LandingPage() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <>
      <Head>
        <title>ISAFlow — Modern Accounting for South African Businesses</title>
        <meta name="description" content="Cloud accounting software built for SA. VAT, SARS compliance, bank reconciliation, invoicing, payroll — all in one platform." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <div className="min-h-screen bg-white text-gray-900">

        {/* ============ NAVBAR ============ */}
        <nav className={`fixed top-0 w-full z-50 transition-all duration-300 ${scrolled ? 'bg-white/95 backdrop-blur-md shadow-sm' : 'bg-transparent'}`}>
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-16 lg:h-20">
              {/* Logo */}
              <Link href="/" className="flex items-center">
                <img src="/logo.png" alt="ISAFlow" className="h-10 sm:h-12 lg:h-14 w-auto" />
              </Link>

              {/* Desktop links */}
              <div className="hidden lg:flex items-center gap-8">
                <a href="#features" className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">Features</a>
                <a href="#pricing" className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">Pricing</a>
                <a href="#testimonials" className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">Testimonials</a>
                <a href="#faq" className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">FAQ</a>
              </div>

              {/* Desktop CTA */}
              <div className="hidden lg:flex items-center gap-3">
                <a href={`${APP_URL}/login`} className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors">
                  Sign In
                </a>
                <a href={`${APP_URL}/register`} className="px-5 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-teal-600 to-teal-500 rounded-xl hover:from-teal-700 hover:to-teal-600 transition-all shadow-lg shadow-teal-500/25 hover:shadow-teal-500/40">
                  Start Free Trial
                </a>
              </div>

              {/* Mobile menu toggle */}
              <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} className="lg:hidden p-2 text-gray-600">
                {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
              </button>
            </div>
          </div>

          {/* Mobile menu */}
          {mobileMenuOpen && (
            <div className="lg:hidden bg-white border-t border-gray-100 shadow-lg">
              <div className="px-4 py-4 space-y-3">
                <a href="#features" onClick={() => setMobileMenuOpen(false)} className="block px-3 py-2 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50">Features</a>
                <a href="#pricing" onClick={() => setMobileMenuOpen(false)} className="block px-3 py-2 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50">Pricing</a>
                <a href="#testimonials" onClick={() => setMobileMenuOpen(false)} className="block px-3 py-2 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50">Testimonials</a>
                <a href="#faq" onClick={() => setMobileMenuOpen(false)} className="block px-3 py-2 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50">FAQ</a>
                <hr className="my-2 border-gray-100" />
                <a href={`${APP_URL}/login`} className="block px-3 py-2 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50">Sign In</a>
                <a href={`${APP_URL}/register`} className="block px-3 py-2.5 text-sm font-semibold text-center text-white bg-teal-600 rounded-xl">Start Free Trial</a>
              </div>
            </div>
          )}
        </nav>

        {/* ============ HERO ============ */}
        <section className="relative pt-32 pb-20 lg:pt-44 lg:pb-32 overflow-hidden">
          {/* Background gradient */}
          <div className="absolute inset-0 bg-gradient-to-br from-slate-50 via-white to-teal-50/40" />
          <div className="absolute top-0 right-0 w-[800px] h-[800px] bg-gradient-to-bl from-teal-100/50 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/3" />
          <div className="absolute bottom-0 left-0 w-[600px] h-[600px] bg-gradient-to-tr from-blue-100/30 to-transparent rounded-full blur-3xl translate-y-1/2 -translate-x-1/3" />

          <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
              {/* Left — copy */}
              <div className="max-w-xl">
                <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-teal-50 border border-teal-200 text-teal-700 text-xs font-semibold mb-6 tracking-wide">
                  <Zap className="w-3.5 h-3.5" /> BUILT FOR SOUTH AFRICA
                </div>
                <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight leading-[1.1] mb-6">
                  Accounting that{' '}
                  <span className="bg-gradient-to-r from-teal-600 to-cyan-500 bg-clip-text text-transparent">
                    works for you
                  </span>
                </h1>
                <p className="text-lg sm:text-xl text-gray-600 leading-relaxed mb-8">
                  Invoicing, bank reconciliation, VAT returns, SARS compliance, payroll — everything your business needs in one powerful, beautifully simple platform.
                </p>
                <div className="flex flex-col sm:flex-row gap-3">
                  <a href={`${APP_URL}/register`} className="inline-flex items-center justify-center gap-2 px-7 py-3.5 text-base font-semibold text-white bg-gradient-to-r from-teal-600 to-teal-500 rounded-xl hover:from-teal-700 hover:to-teal-600 transition-all shadow-xl shadow-teal-500/25 hover:shadow-teal-500/40">
                    Start Free Trial <ArrowRight className="w-4 h-4" />
                  </a>
                  <a href="#features" className="inline-flex items-center justify-center gap-2 px-7 py-3.5 text-base font-semibold text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 hover:border-gray-300 transition-all shadow-sm">
                    <PlayCircle className="w-4 h-4" /> See How It Works
                  </a>
                </div>
                <p className="mt-4 text-sm text-gray-500">14-day free trial &middot; No credit card required</p>
                <p className="mt-2 text-sm text-gray-500">Already have an account? <a href={`${APP_URL}/login`} className="text-teal-600 font-medium hover:underline">Sign in</a></p>
              </div>

              {/* Right — hero image */}
              <div className="relative">
                <div className="relative rounded-2xl overflow-hidden shadow-2xl shadow-gray-900/10 border border-gray-200/50">
                  <img
                    src="/landing/hero-dashboard.png"
                    alt="ISAFlow Dashboard"
                    className="w-full"
                    onError={(e) => {
                      const target = e.currentTarget;
                      target.style.display = 'none';
                      const fallback = target.nextElementSibling as HTMLElement;
                      if (fallback) fallback.style.display = 'flex';
                    }}
                  />
                  {/* Fallback gradient placeholder */}
                  <div className="hidden aspect-[16/10] bg-gradient-to-br from-slate-800 via-slate-900 to-gray-900 items-center justify-center" style={{ display: 'none' }}>
                    <div className="text-center">
                      <BookOpen className="w-16 h-16 text-teal-400 mx-auto mb-4" />
                      <p className="text-teal-300 text-lg font-semibold">ISAFlow Dashboard</p>
                      <p className="text-gray-500 text-sm mt-1">Run image generation script to populate</p>
                    </div>
                  </div>
                </div>
                {/* Floating stat cards */}
                <div className="absolute -bottom-6 -left-6 bg-white rounded-xl shadow-xl p-4 border border-gray-100">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center">
                      <TrendingUp className="w-5 h-5 text-green-600" />
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Revenue</p>
                      <p className="text-lg font-bold text-gray-900">R 1.2M</p>
                    </div>
                  </div>
                </div>
                <div className="absolute -top-4 -right-4 bg-white rounded-xl shadow-xl p-4 border border-gray-100">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-teal-50 flex items-center justify-center">
                      <BadgeCheck className="w-5 h-5 text-teal-600" />
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Reconciled</p>
                      <p className="text-lg font-bold text-gray-900">98.7%</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ============ STATS BAR ============ */}
        <section className="relative py-12 bg-gray-900">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
              {STATS.map((s) => (
                <div key={s.label} className="text-center">
                  <p className="text-3xl lg:text-4xl font-extrabold text-white">{s.value}</p>
                  <p className="text-sm text-gray-400 mt-1">{s.label}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ============ FEATURES GRID ============ */}
        <section id="features" className="py-20 lg:py-28">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center max-w-2xl mx-auto mb-16">
              <p className="text-sm font-semibold text-teal-600 tracking-wide uppercase mb-3">Everything You Need</p>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">
                One platform. Complete control.
              </h2>
              <p className="text-lg text-gray-600">
                From invoicing to SARS returns, ISAFlow handles every aspect of your South African business accounting.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {FEATURES.map((f) => (
                <div key={f.title} className="group p-6 rounded-2xl border border-gray-100 hover:border-teal-200 hover:shadow-lg hover:shadow-teal-500/5 transition-all duration-300">
                  <div className="w-12 h-12 rounded-xl bg-teal-50 flex items-center justify-center mb-4 group-hover:bg-teal-100 transition-colors">
                    <f.icon className="w-6 h-6 text-teal-600" />
                  </div>
                  <h3 className="text-base font-semibold mb-2">{f.title}</h3>
                  <p className="text-sm text-gray-600 leading-relaxed">{f.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ============ DETAILED FEATURES ============ */}
        <section className="py-20 lg:py-28 bg-gradient-to-b from-gray-50 to-white">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="space-y-24 lg:space-y-32">
              {DETAILED_FEATURES.map((f, i) => (
                <div key={f.title} className={`grid lg:grid-cols-2 gap-12 lg:gap-16 items-center ${i % 2 === 1 ? 'lg:flex-row-reverse' : ''}`}>
                  {/* Text */}
                  <div className={i % 2 === 1 ? 'lg:order-2' : ''}>
                    <span className="inline-block px-3 py-1 rounded-full bg-teal-50 text-teal-700 text-xs font-semibold mb-4">{f.badge}</span>
                    <h3 className="text-2xl sm:text-3xl font-bold tracking-tight mb-4">{f.title}</h3>
                    <p className="text-gray-600 leading-relaxed mb-6">{f.desc}</p>
                    <ul className="space-y-3">
                      {f.bullets.map((b) => (
                        <li key={b} className="flex items-start gap-3">
                          <Check className="w-5 h-5 text-teal-500 mt-0.5 flex-shrink-0" />
                          <span className="text-sm text-gray-700">{b}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  {/* Image */}
                  <div className={i % 2 === 1 ? 'lg:order-1' : ''}>
                    <div className="relative rounded-2xl overflow-hidden shadow-xl border border-gray-200/50">
                      <img
                        src={`/landing/${f.imgKey}.png`}
                        alt={f.title}
                        className="w-full"
                        onError={(e) => {
                          const target = e.currentTarget;
                          target.style.display = 'none';
                          const fallback = target.nextElementSibling as HTMLElement;
                          if (fallback) fallback.style.display = 'flex';
                        }}
                      />
                      <div className="hidden aspect-[16/10] bg-gradient-to-br from-slate-800 to-gray-900 items-center justify-center" style={{ display: 'none' }}>
                        <div className="text-center p-8">
                          <Layers className="w-12 h-12 text-teal-400 mx-auto mb-3" />
                          <p className="text-teal-300 font-semibold">{f.title}</p>
                          <p className="text-gray-500 text-xs mt-1">Image placeholder</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ============ PRICING ============ */}
        <section id="pricing" className="py-20 lg:py-28">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center max-w-2xl mx-auto mb-16">
              <p className="text-sm font-semibold text-teal-600 tracking-wide uppercase mb-3">Simple Pricing</p>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">
                Plans that grow with your business
              </h2>
              <p className="text-lg text-gray-600">
                Start with a 14-day free trial on any plan. No credit card required.
              </p>
            </div>

            <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
              {PRICING_TIERS.map((tier) => (
                <div
                  key={tier.name}
                  className={`relative rounded-2xl p-8 ${
                    tier.popular
                      ? 'bg-gray-900 text-white shadow-2xl shadow-gray-900/20 scale-[1.02] ring-2 ring-teal-500'
                      : 'bg-white border border-gray-200 shadow-sm'
                  }`}
                >
                  {tier.popular && (
                    <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                      <span className="inline-flex items-center gap-1 px-4 py-1.5 rounded-full bg-gradient-to-r from-teal-500 to-cyan-500 text-white text-xs font-bold shadow-lg">
                        <Star className="w-3 h-3" /> MOST POPULAR
                      </span>
                    </div>
                  )}

                  <h3 className={`text-lg font-semibold mb-1 ${tier.popular ? 'text-white' : 'text-gray-900'}`}>
                    {tier.name}
                  </h3>
                  <p className={`text-sm mb-6 ${tier.popular ? 'text-gray-400' : 'text-gray-500'}`}>
                    {tier.desc}
                  </p>

                  <div className="flex items-baseline gap-1 mb-8">
                    <span className={`text-4xl font-extrabold ${tier.popular ? 'text-white' : 'text-gray-900'}`}>
                      {tier.price}
                    </span>
                    <span className={`text-sm ${tier.popular ? 'text-gray-400' : 'text-gray-500'}`}>
                      {tier.period}
                    </span>
                  </div>

                  <ul className="space-y-3 mb-8">
                    {tier.features.map((feat) => (
                      <li key={feat} className="flex items-start gap-2.5">
                        <Check className={`w-4 h-4 mt-0.5 flex-shrink-0 ${tier.popular ? 'text-teal-400' : 'text-teal-500'}`} />
                        <span className={`text-sm ${tier.popular ? 'text-gray-300' : 'text-gray-600'}`}>{feat}</span>
                      </li>
                    ))}
                  </ul>

                  <a
                    href={tier.name === 'Enterprise' ? '#contact' : `${APP_URL}/register`}
                    className={`block w-full text-center py-3 rounded-xl text-sm font-semibold transition-all ${
                      tier.popular
                        ? 'bg-gradient-to-r from-teal-500 to-cyan-500 text-white hover:from-teal-600 hover:to-cyan-600 shadow-lg shadow-teal-500/25'
                        : 'bg-gray-900 text-white hover:bg-gray-800'
                    }`}
                  >
                    {tier.cta}
                  </a>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ============ TESTIMONIALS ============ */}
        <section id="testimonials" className="py-20 lg:py-28 bg-gradient-to-b from-gray-50 to-white">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center max-w-2xl mx-auto mb-16">
              <p className="text-sm font-semibold text-teal-600 tracking-wide uppercase mb-3">Testimonials</p>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">
                Trusted by businesses across South Africa
              </h2>
            </div>

            <div className="grid md:grid-cols-3 gap-8">
              {TESTIMONIALS.map((t) => (
                <div key={t.name} className="bg-white rounded-2xl p-8 shadow-sm border border-gray-100">
                  <div className="flex gap-1 mb-4">
                    {Array.from({ length: t.stars }).map((_, i) => (
                      <Star key={i} className="w-4 h-4 text-amber-400 fill-amber-400" />
                    ))}
                  </div>
                  <p className="text-gray-700 leading-relaxed mb-6 text-sm">&ldquo;{t.quote}&rdquo;</p>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-teal-500 to-cyan-500 flex items-center justify-center text-white font-bold text-sm">
                      {t.name.split(' ').map(n => n[0]).join('')}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{t.name}</p>
                      <p className="text-xs text-gray-500">{t.role}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ============ FAQ ============ */}
        <section id="faq" className="py-20 lg:py-28">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-16">
              <p className="text-sm font-semibold text-teal-600 tracking-wide uppercase mb-3">FAQ</p>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
                Common questions
              </h2>
            </div>

            <div className="space-y-3">
              {FAQ_ITEMS.map((item, i) => (
                <div key={i} className="border border-gray-200 rounded-xl overflow-hidden">
                  <button
                    onClick={() => setOpenFaq(openFaq === i ? null : i)}
                    className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-gray-50 transition-colors"
                  >
                    <span className="text-sm font-semibold text-gray-900 pr-4">{item.q}</span>
                    <ChevronDown className={`w-5 h-5 text-gray-400 flex-shrink-0 transition-transform duration-200 ${openFaq === i ? 'rotate-180' : ''}`} />
                  </button>
                  {openFaq === i && (
                    <div className="px-6 pb-4">
                      <p className="text-sm text-gray-600 leading-relaxed">{item.a}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ============ FINAL CTA ============ */}
        <section className="py-20 lg:py-28 bg-gray-900 relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-teal-900/30 to-transparent" />
          <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-teal-500/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3" />

          <div className="relative max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <h2 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight mb-4">
              Ready to modernise your accounting?
            </h2>
            <p className="text-lg text-gray-400 mb-8 max-w-xl mx-auto">
              Join South African businesses who have already made the switch to ISAFlow. Start your 14-day free trial today.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <a href={`${APP_URL}/register`} className="inline-flex items-center justify-center gap-2 px-8 py-3.5 text-base font-semibold text-white bg-gradient-to-r from-teal-500 to-cyan-500 rounded-xl hover:from-teal-600 hover:to-cyan-600 transition-all shadow-xl shadow-teal-500/25">
                Start Free Trial <ArrowRight className="w-4 h-4" />
              </a>
              <a href="#contact" className="inline-flex items-center justify-center gap-2 px-8 py-3.5 text-base font-semibold text-white border border-gray-600 rounded-xl hover:bg-gray-800 transition-all">
                Contact Sales
              </a>
            </div>
          </div>
        </section>

        {/* ============ FOOTER ============ */}
        <footer className="bg-gray-950 text-gray-400 py-16">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-10 mb-12">
              {/* Brand */}
              <div>
                <div className="mb-4">
                  <img src="/logo.png" alt="ISAFlow" className="h-10 w-auto brightness-0 invert" />
                </div>
                <p className="text-sm leading-relaxed">
                  Modern cloud accounting software built specifically for South African businesses. SARS-compliant from day one.
                </p>
              </div>

              {/* Product */}
              <div>
                <h4 className="text-sm font-semibold text-white mb-4">Product</h4>
                <ul className="space-y-2.5 text-sm">
                  <li><a href="#features" className="hover:text-white transition-colors">Features</a></li>
                  <li><a href="#pricing" className="hover:text-white transition-colors">Pricing</a></li>
                  <li><a href={`${APP_URL}/login`} className="hover:text-white transition-colors">Sign In</a></li>
                  <li><span className="opacity-50 cursor-default" title="Coming soon">API Documentation</span></li>
                </ul>
              </div>

              {/* Resources */}
              <div>
                <h4 className="text-sm font-semibold text-white mb-4">Resources</h4>
                <ul className="space-y-2.5 text-sm">
                  <li><a href="#faq" className="hover:text-white transition-colors">FAQ</a></li>
                  <li><span className="opacity-50 cursor-default" title="Coming soon">Help Centre</span></li>
                  <li><span className="opacity-50 cursor-default" title="Coming soon">Blog</span></li>
                  <li><span className="opacity-50 cursor-default" title="Coming soon">SARS Compliance Guide</span></li>
                </ul>
              </div>

              {/* Company */}
              <div>
                <h4 className="text-sm font-semibold text-white mb-4">Company</h4>
                <ul className="space-y-2.5 text-sm">
                  <li><span className="opacity-50 cursor-default" title="Coming soon">About</span></li>
                  <li><a href="#contact" className="hover:text-white transition-colors">Contact</a></li>
                  <li><span className="opacity-50 cursor-default" title="Coming soon">Privacy Policy</span></li>
                  <li><span className="opacity-50 cursor-default" title="Coming soon">Terms of Service</span></li>
                </ul>
              </div>
            </div>

            <div className="border-t border-gray-800 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
              <p className="text-xs">&copy; {new Date().getFullYear()} ISAFlow. All rights reserved.</p>
              <div className="flex items-center gap-2 text-xs">
                <Shield className="w-3.5 h-3.5 text-teal-500" />
                <span>SARS Compliant &middot; POPIA Compliant &middot; 256-bit SSL Encryption</span>
              </div>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}
