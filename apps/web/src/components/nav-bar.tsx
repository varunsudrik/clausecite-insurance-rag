'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { logout } from '@/lib/session';
import { useSessionRole } from '@/lib/use-session-role';

const links = [
  { href: '/', label: 'Chat' },
  { href: '/documents', label: 'Policies' },
];

export function NavBar() {
  const role = useSessionRole();
  const pathname = usePathname();
  const router = useRouter();

  const linkClass = (active: boolean) =>
    `rounded px-2 py-1 text-sm ${
      active
        ? 'bg-zinc-100 font-medium dark:bg-zinc-800'
        : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
    }`;

  return (
    <header className="border-b border-zinc-200 dark:border-zinc-800">
      <nav aria-label="Main" className="mx-auto flex w-full max-w-6xl items-center gap-2 px-4 py-3">
        <Link href="/" className="mr-4 flex items-center gap-2 font-semibold tracking-tight">
          <span
            aria-hidden="true"
            className="grid size-6 place-items-center rounded bg-zinc-900 text-xs text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            §
          </span>
          ClauseCite
        </Link>
        {links.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            aria-current={pathname === href ? 'page' : undefined}
            className={linkClass(pathname === href)}
          >
            {label}
          </Link>
        ))}
        <span className="flex-1" />
        {role === 'admin' ? (
          <button
            type="button"
            onClick={() => {
              logout();
              router.push('/');
            }}
            className={linkClass(false)}
          >
            Log out
          </button>
        ) : (
          <Link
            href="/admin"
            aria-current={pathname === '/admin' ? 'page' : undefined}
            className={linkClass(pathname === '/admin')}
          >
            Admin login
          </Link>
        )}
      </nav>
    </header>
  );
}
