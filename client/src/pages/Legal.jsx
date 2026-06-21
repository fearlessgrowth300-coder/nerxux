// Public legal/info pages required for OAuth app review (Facebook/Google):
// Privacy Policy, Terms of Service, and Data Deletion instructions.
// These render without auth so reviewers and users can reach them directly.

const UPDATED = 'June 2026'

function Page({ title, children }) {
  return (
    <div className="min-h-full overflow-y-auto bg-nexus-bg px-4 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <a href="/" className="text-sm text-nexus-accent2 hover:underline">← Nexus AI</a>
        <h1 className="mt-4 text-2xl font-semibold text-gray-100">{title}</h1>
        <p className="mt-1 text-xs text-gray-500">Last updated: {UPDATED}</p>
        <div className="mt-6 space-y-4 text-sm leading-relaxed text-gray-300">{children}</div>
      </div>
    </div>
  )
}
function H({ children }) { return <h2 className="pt-4 text-base font-semibold text-gray-100">{children}</h2> }

export function PrivacyPolicy() {
  return (
    <Page title="Privacy Policy">
      <p>Nexus AI ("we", "the app") is a multi-model AI hub. This policy explains what we collect and how we use it.</p>
      <H>What we collect</H>
      <ul className="list-disc space-y-1 pl-5">
        <li><b>Account:</b> your email (via Supabase authentication) and an account ID.</li>
        <li><b>Content you create:</b> your instructions, skills, and chat messages (chats are stored in your browser).</li>
        <li><b>Connections:</b> API keys and OAuth tokens for services you connect. These are <b>encrypted at rest</b> and used only to perform actions you request.</li>
        <li><b>Connected-service data:</b> when you connect an account (e.g. Facebook, YouTube), we access only the data needed to fulfil your request (e.g. your ad accounts, channel stats), at the time you ask for it.</li>
      </ul>
      <H>How we use it</H>
      <p>To provide the service: route your prompts to AI models, run tools you invoke, and show results. We do not sell your data. We do not use your connected-account data for advertising.</p>
      <H>Sharing</H>
      <p>Prompts and necessary context are sent to the AI/model providers and tool services you choose (e.g. Anthropic, OpenAI, Google, Higgsfield, Facebook) to fulfil your request, subject to their policies.</p>
      <H>Retention &amp; deletion</H>
      <p>You can disconnect any service at any time (Connections), clear chats (Settings → Privacy), or delete your account (Settings → Account), which removes your instructions, skills, connections, and tokens. See our <a className="text-nexus-accent2 hover:underline" href="/data-deletion">Data Deletion</a> page.</p>
      <H>Contact</H>
      <p>For privacy questions, contact the app operator at the email shown in the app.</p>
    </Page>
  )
}

export function Terms() {
  return (
    <Page title="Terms of Service">
      <p>By using Nexus AI you agree to these terms.</p>
      <H>Use of the service</H>
      <p>You may use the app to interact with AI models and connect third-party accounts you own or are authorized to use. You are responsible for your content and for complying with the terms of any service you connect (e.g. Facebook, Google).</p>
      <H>Accounts &amp; connections</H>
      <p>Keep your credentials secure. You may disconnect services or delete your account at any time.</p>
      <H>Acceptable use</H>
      <p>Don't use the app for unlawful activity, to violate others' rights, or to abuse connected platforms' APIs or policies.</p>
      <H>Disclaimer</H>
      <p>The service is provided "as is" without warranties. AI output may be inaccurate; verify important results. We are not liable for damages arising from use of the service to the extent permitted by law.</p>
      <H>Changes</H>
      <p>We may update these terms; continued use means acceptance of the updated terms.</p>
    </Page>
  )
}

export function DataDeletion() {
  return (
    <Page title="Data Deletion">
      <p>You can delete your data from Nexus AI at any time. We don't need to keep data from connected accounts after you disconnect.</p>
      <H>Disconnect a service (e.g. Facebook)</H>
      <p>Go to <b>Connections</b>, find the connector, and click <b>Disconnect</b> / <b>Remove</b>. This deletes the stored OAuth tokens for that service immediately.</p>
      <H>Clear your chats</H>
      <p>Go to <b>Settings → Privacy → Clear all chats</b>.</p>
      <H>Delete your entire account</H>
      <p>Go to <b>Settings → Account → Delete account</b>. This permanently removes your account and all associated data: instructions, skills, API keys, and every connector/OAuth token.</p>
      <p className="text-xs text-gray-500">If you can't access your account, contact the app operator to request deletion.</p>
    </Page>
  )
}
