import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { APP_URL } from './landingData';

interface Props {
  scrolled: boolean;
  mobileMenuOpen: boolean;
  onToggleMobile: () => void;
  onCloseMobile: () => void;
}

// Pricing has its own page; the rest are anchors on the landing page, prefixed
// with '/' so they resolve from any route (including /pricing itself).
const NAV_LINKS = [
  { label: 'Features', href: '/#features' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Testimonials', href: '/#testimonials' },
  { label: 'FAQ', href: '/#faq' },
];

export function LandingNavbar({ scrolled, mobileMenuOpen, onToggleMobile, onCloseMobile }: Props) {
  const navBg = scrolled
    ? 'bg-[rgba(5,10,15,0.92)] border-b border-white/10'
    : 'bg-[rgba(5,10,15,0.6)] border-b border-white/8';

  return (
    <nav className={`fixed top-0 w-full z-50 transition-all duration-300 backdrop-blur-xl ${navBg}`}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 lg:h-20">
          <Link href="/" className="flex items-center">
            <img src="/logo.png" alt="ISAFlow" className="h-8 sm:h-10 w-auto brightness-0 invert" />
          </Link>

          <div className="hidden lg:flex items-center gap-8">
            {NAV_LINKS.map(({ label, href }) => (
              <Link
                key={label}
                href={href}
                className="text-sm font-medium text-white/65 hover:text-white transition-colors duration-200"
              >
                {label}
              </Link>
            ))}
          </div>

          <div className="hidden lg:flex items-center gap-3">
            <a
              href={`${APP_URL}/login`}
              className="px-4 py-2 text-sm font-medium text-white/65 hover:text-white transition-colors duration-200"
            >
              Sign In
            </a>
            <a
              href={`${APP_URL}/register`}
              className="px-5 py-2.5 text-sm font-semibold text-slate-900 bg-white rounded-xl hover:bg-white/90 transition-all"
            >
              Start Free Trial
            </a>
          </div>

          <button onClick={onToggleMobile} className="lg:hidden p-2 text-white/70 hover:text-white">
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>
      </div>

      {mobileMenuOpen && (
        <div className="lg:hidden bg-[rgba(5,10,15,0.97)] border-t border-white/10">
          <div className="px-4 py-4 space-y-1">
            {NAV_LINKS.map(({ label, href }) => (
              <Link
                key={label}
                href={href}
                onClick={onCloseMobile}
                className="block px-3 py-2.5 text-sm font-medium text-white/70 rounded-lg hover:text-white hover:bg-white/5"
              >
                {label}
              </Link>
            ))}
            <hr className="my-2 border-white/10" />
            <a href={`${APP_URL}/login`} className="block px-3 py-2.5 text-sm font-medium text-white/70 rounded-lg hover:text-white hover:bg-white/5">Sign In</a>
            <a href={`${APP_URL}/register`} className="block px-3 py-2.5 text-sm font-semibold text-center text-slate-900 bg-white rounded-xl mt-2">Start Free Trial</a>
          </div>
        </div>
      )}
    </nav>
  );
}
