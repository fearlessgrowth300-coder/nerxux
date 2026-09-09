import { useEffect, useState } from 'react'

// "Install Nexus on this device" — surfaces the browser's own install prompt
// where one exists (Chrome/Edge on Android + desktop), and spells out the
// manual route on iOS, which has no prompt API.
let deferredPrompt = null
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredPrompt = e
    window.dispatchEvent(new Event('nexus:installable'))
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    window.dispatchEvent(new Event('nexus:installed'))
  })
}

function isStandalone() {
  return typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true)
}
const isIOS = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent)

export default function InstallApp() {
  const [installable, setInstallable] = useState(Boolean(deferredPrompt))
  const [installed, setInstalled] = useState(isStandalone())

  useEffect(() => {
    const on = () => setInstallable(true)
    const done = () => { setInstalled(true); setInstallable(false) }
    window.addEventListener('nexus:installable', on)
    window.addEventListener('nexus:installed', done)
    return () => { window.removeEventListener('nexus:installable', on); window.removeEventListener('nexus:installed', done) }
  }, [])

  async function install() {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    if (outcome === 'accepted') { deferredPrompt = null; setInstallable(false) }
  }

  return (
    <div className="rounded-xl border border-nexus-border bg-nexus-panel p-4">
      <h3 className="font-medium text-gray-100">Install Nexus on this device</h3>
      {installed ? (
        <p className="mt-1 text-sm text-gray-400">You're running the installed app.</p>
      ) : installable ? (
        <>
          <p className="mt-1 text-sm text-gray-400">Opens full-screen from your home screen or dock, like a native app.</p>
          <button onClick={install}
            className="mt-3 rounded-lg bg-nexus-accent px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-500">
            Install app
          </button>
        </>
      ) : isIOS ? (
        <p className="mt-1 text-sm text-gray-400">
          In Safari: tap <span className="text-gray-200">Share</span> → <span className="text-gray-200">Add to Home Screen</span>.
        </p>
      ) : (
        <p className="mt-1 text-sm text-gray-400">
          Use the install icon in your browser's address bar (Chrome/Edge), or the browser menu → <span className="text-gray-200">Install app</span>.
        </p>
      )}
    </div>
  )
}
