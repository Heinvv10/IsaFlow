/**
 * Company detail, Users tab: the company's members (getCompanyUsers' shape, see companyDetailModel).
 */
import { Loader2 } from 'lucide-react';
import { formatLastSeen } from '@/components/admin/formatLastSeen';
import type { CompanyUser } from './companyDetailModel';

export function CompanyUsersTab({ users, usersLoading }: { users: CompanyUser[]; usersLoading: boolean }) {
  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
      {usersLoading
        ? <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-teal-500" /></div>
        : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium">Last Login</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-600 dark:text-gray-400">No users</td></tr>}
                {users.map(u => (
                  <tr key={u.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{u.name}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{u.email}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300 capitalize">{u.role}</td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{formatLastSeen(u.last_login)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    </div>
  );
}
