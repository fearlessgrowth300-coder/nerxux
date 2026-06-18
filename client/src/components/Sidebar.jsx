import { NavLink } from 'react-router-dom'
import {
  ChatIcon,
  SkillsIcon,
  InstructionsIcon,
  ConnectionsIcon,
  SettingsIcon,
  CloseIcon,
} from './icons'

const NAV = [
  { to: '/chat', label: 'Chat', Icon: ChatIcon },
  { to: '/skills', label: 'Skills', Icon: SkillsIcon },
  { to: '/instructions', label: 'Instructions', Icon: InstructionsIcon },
  { to: '/connections', label: 'Connections', Icon: ConnectionsIcon },
  { to: '/settings', label: 'Settings', Icon: SettingsIcon },
]

// Sidebar navigation. On desktop it's a fixed column; on mobile it slides in as
// a drawer controlled by `open` / `onClose` from the layout.
export default function Sidebar({ open, onClose }) {
  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={[
          'fixed z-40 flex h-full w-64 flex-col border-r border-nexus-border bg-nexus-panel transition-transform duration-200',
          'md:static md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <span className="bg-gradient-to-r from-nexus-accent to-nexus-accent2 bg-clip-text text-xl font-bold text-transparent">
            Nexus AI
          </span>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 hover:bg-white/5 md:hidden"
            aria-label="Close menu"
          >
            <CloseIcon />
          </button>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-2">
          {NAV.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              onClick={onClose}
              className={({ isActive }) =>
                [
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition',
                  isActive
                    ? 'bg-nexus-accent/15 text-white'
                    : 'text-gray-400 hover:bg-white/5 hover:text-gray-200',
                ].join(' ')
              }
            >
              <Icon className="h-5 w-5 shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="px-5 py-4 text-xs text-gray-600">v0.1.0</div>
      </aside>
    </>
  )
}
