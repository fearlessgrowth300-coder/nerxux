// Consistent page wrapper: padded, max-width, title + optional description and
// header actions. Used by every route page so the dashboard feels uniform.
export default function PageShell({ title, description, actions, children }) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 md:py-8">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">{title}</h1>
          {description && (
            <p className="mt-1 text-sm text-gray-400">{description}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  )
}
