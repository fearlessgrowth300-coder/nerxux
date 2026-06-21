import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { applyAppearance, getPrefs } from './lib/prefs'
import ProtectedRoute from './components/ProtectedRoute'
import DashboardLayout from './components/DashboardLayout'
import Login from './pages/Login'
import Signup from './pages/Signup'
import { PrivacyPolicy, Terms, DataDeletion } from './pages/Legal'
import Chat from './pages/Chat'
import Skills from './pages/Skills'
import Instructions from './pages/Instructions'
import Connections from './pages/Connections'
import Settings from './pages/Settings'

// Applies the current user's appearance prefs (accent + font) on load/change.
function AppearanceSync() {
  const { user } = useAuth()
  useEffect(() => {
    applyAppearance(getPrefs(user?.id))
  }, [user?.id])
  return null
}

export default function App() {
  return (
    <AuthProvider>
      <AppearanceSync />
      <BrowserRouter>
        <Routes>
          {/* Public */}
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/privacy" element={<PrivacyPolicy />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/data-deletion" element={<DataDeletion />} />

          {/* Protected dashboard shell with nested routes */}
          <Route
            element={
              <ProtectedRoute>
                <DashboardLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="/chat" replace />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/skills" element={<Skills />} />
            <Route path="/instructions" element={<Instructions />} />
            <Route path="/connections" element={<Connections />} />
            <Route path="/settings" element={<Settings />} />
          </Route>

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
