import PageShell from '../components/PageShell'
import { useAuth } from '../context/AuthContext'

// Settings route — functional now: shows account info and sign-out. Additional
// preferences can be added here in later steps.
export default function Settings() {
  const { user, signOut } = useAuth()

  return (
    <PageShell title="Settings" description="Manage your account.">
      <div className="space-y-4">
        <section className="rounded-xl border border-nexus-border bg-nexus-panel p-5">
          <h2 className="text-sm font-semibold text-gray-200">Account</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500">Email</dt>
              <dd className="truncate text-gray-200">{user?.email}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-gray-500">User ID</dt>
              <dd className="truncate font-mono text-xs text-gray-400">
                {user?.id}
              </dd>
            </div>
          </dl>
        </section>

        <section className="rounded-xl border border-nexus-border bg-nexus-panel p-5">
          <h2 className="text-sm font-semibold text-gray-200">Session</h2>
          <p className="mt-1 text-sm text-gray-400">
            Sign out of this device.
          </p>
          <button
            onClick={signOut}
            className="mt-4 rounded-lg border border-nexus-border px-4 py-2 text-sm text-gray-200 transition hover:bg-white/5"
          >
            Sign out
          </button>
        </section>
      </div>
    </PageShell>
  )
}
