import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'

// Renders assistant messages as GitHub-flavored Markdown with syntax-highlighted
// fenced code blocks. Inline code and other elements are styled via Tailwind's
// prose-ish utility classes applied here (we avoid the typography plugin to keep
// the dependency list to exactly what Step 1 installed).
export default function Markdown({ children }) {
  return (
    <div className="space-y-3 text-sm leading-relaxed text-gray-100">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Render fenced code with highlighting; inline code as a chip.
          code({ inline, className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '')
            const isBlock = !inline && match
            if (isBlock) {
              return (
                <SyntaxHighlighter
                  language={match[1]}
                  style={oneDark}
                  customStyle={{
                    margin: 0,
                    borderRadius: '0.5rem',
                    background: '#0b0f17',
                    fontSize: '0.8rem',
                  }}
                  PreTag="div"
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              )
            }
            return (
              <code
                className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[0.8em] text-nexus-accent2"
                {...props}
              >
                {children}
              </code>
            )
          },
          // react-markdown wraps block code in <pre>; let the highlighter own it.
          pre({ children }) {
            return <div className="overflow-x-auto">{children}</div>
          },
          a({ children, ...props }) {
            return (
              <a
                className="text-nexus-accent2 underline hover:opacity-80"
                target="_blank"
                rel="noreferrer"
                {...props}
              >
                {children}
              </a>
            )
          },
          ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
          h1: ({ children }) => <h1 className="text-lg font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="text-base font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold">{children}</h3>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-nexus-border pl-3 text-gray-400">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-nexus-border px-2 py-1 font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-nexus-border px-2 py-1">{children}</td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
