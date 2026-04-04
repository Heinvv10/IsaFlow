import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { APP_URL } from './landingData';

interface Props {
  scrolled: boolean;
  mobileMenuOpen: boolean;
  onToggleMobile: () => void;
  onCloseMobile: () => void;
}

export function LandingNavbar({ scrolled, mobileMenuOpen, onToggleMobile, onCloseMobile }: Props) {
  return (
    <nav className={`fixed top-0 w-full z-50 transition-all duration-300 ${scrolled ? 'bg-white/95 backdrop-blur-md shadow-sm' : 'bg-transparent'}`}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 lg:h-20">
          <Link href="/" className="flex items-center">
            <img src="/logo.png" alt="ISAFlow" className="h-10 sm:h-12 lg:h-14 w-auto" />
          </Link>

          <div className="hidden lg:flex items-center gap-8">
            <a href="#features" className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">Features</a>
            <a href="#pricing" className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">Pricing</a>
            <a href="#testimonials" className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">Testimonials</a>
            <a href="#faq" className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">FAQ</a>
          </div>

          <div className="hidden lg:flex items-center gap-3">
            <a href={`${APP_URL}/login`} className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors">
              Sign In
            </a>
            <a href={`${APP_URL}/register`} className="px-5 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-teal-600 to-teal-500 rounded-xl hover:from-teal-700 hover:to-teal-600 transition-all shadow-lg shadow-teal-500/25 hover:shadow-teal-500/40">
              Start Free Trial
            </a>
          </div>

          <button onClick={onToggleMobile} className="lg:hidden p-2 text-gray-600">
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>
      </div>

      {mobileMenuOpen && (
        <div className="lg:hidden bg-white border-t border-gray-100 shadow-lg">
          <div className="px-4 py-4 space-y-3">
            <a href="#features" onClick={onCloseMobile} className="block px-3 py-2 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50">Features</a>
            <a href="#pricing" onClick={onCloseMobile} className="block px-3 py-2 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50">Pricing</a>
            <a href="#testimonials" onClick={onCloseMobile} className="block px-3 py-2 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50">Testimonials</a>
            <a href="#faq" onClick={onCloseMobile} className="block px-3 py-2 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50">FAQ</a>
            <hr className="my-2 border-gray-100" />
            <a href={`${APP_URL}/login`} className="block px-3 py-2 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-50">Sign In</a>
            <a href={`${APP_URL}/register`} className="block px-3 py-2.5 text-sm font-semibold text-center text-white bg-teal-600 rounded-xl">Start Free Trial</a>
          </div>
        </div>
      )}
    </nav>
  );
}
