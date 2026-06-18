import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { MenuIcon, LogoutIcon } from './icons'

// Derive up-to-two-letter initials from an email for the avatar.
function initialsFromEmail(email = '') {
  const name = email.split('@')[0] || '?'
  const parts = name.split(/[._-]+/).filter(Boolean)
  const letters = (parts[0]?.[0] || '') + (parts[1]?.[0] || '')
  return (letters || name[0] || '?').toUpperCase()
}

export default function TopBar({ onMenuClick }) {
  const { user, signOut } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)

  // Close the avatar dropdown on outside click.
  useEffect(() => {
    function onDocClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  return (
    <header className="flex h-14 items-center justify-between border-b border-nexus-border bg-nexus-panel px-4">
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuClick}
          className="rounded-lg p-1.5 text-gray-300 hover:bg-white/5 md:hidden"
          aria-label="Open menu"
        >
          <MenuIcon />
        </button>
        <span className="text-sm font-semibold text-gray-200">Nexus AI</span>
      </div>

      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="flex items-center gap-2 rounded-full p-0.5 transition hover:bg-white/5"
          aria-label="Account menu"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-nexus-accent to-nexus-accent2 text-sm font-semibold text-white">
            {initialsFromEmail(user?.email)}
          </span>
        </button>

        {menuOpen && (
          <div className="absolute right-0 mt-2 w-56 overflow-hidden rounded-xl border border-nexus-border bg-nexus-panel shadow-xl">
            <div className="border-b border-nexus-border px-4 py-3">
              <p className="text-xs text-gray-500">Signed in as</p>
              <p className="truncate text-sm text-gray-200">{user?.email}</p>
            </div>
            <button
              onClick={signOut}
              className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-gray-300 transition hover:bg-white/5"
            >
              <LogoutIcon className="h-4 w-4" />
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
