// R-X-02, R-X-03, R-X-05, R-X-06.
import { DISCLAIMER_TEXT, FEEDBACK_FORM_URL, PRIVACY_TEXT } from '../config'
import { GLOSSARY } from '../glossary'
import type { ReactNode } from 'react'

/** `themeSwitch`: on a phone the theme choice (R-X-04) sits here rather than in the header */
export function Footer({ themeSwitch = null }: { themeSwitch?: ReactNode }) {
  return (
    <footer className="foot">
      {themeSwitch && (
        <div className="foot-theme">
          <span aria-hidden="true">Theme</span>
          {themeSwitch}
        </div>
      )}
      <p data-testid="footer-disclaimer">{DISCLAIMER_TEXT}</p>
      <p>{PRIVACY_TEXT}</p>
      <p>
        {/* a new tab, so the deal stays open in this one */}
        <a href={FEEDBACK_FORM_URL} target="_blank" rel="noopener noreferrer">
          Send feedback
        </a>{' '}
        <span className="warn-text">Please don&apos;t send real investor information.</span>
      </p>
      <details className="glossary">
        <summary>Glossary</summary>
        <dl>
          {Object.entries(GLOSSARY).map(([term, text]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </details>
    </footer>
  )
}
