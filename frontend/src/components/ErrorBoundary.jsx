import { Component } from 'react';
import { useLocation } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';

// Shows a message instead of a blank page when a screen fails to render,
// and resets itself when the user navigates to another page.
class Boundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('UI error', error, info?.componentStack); }
  componentDidUpdate(prev) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    const { t } = this.props;
    return (
      <div className="alert red" role="alert">
        <b>{t('ui_error_title')}</b>
        <div className="small mt-s" dir="ltr">{String(this.state.error.message || this.state.error)}</div>
        <div className="row gap mt">
          <button className="btn btn-default btn-sm" onClick={() => window.location.reload()}>{t('ui_error_reload')}</button>
          <a className="btn btn-default btn-sm" href="/">{t('nav_home')}</a>
        </div>
      </div>
    );
  }
}

export default function ErrorBoundary({ children }) {
  const { t } = useI18n();
  const loc = useLocation();
  return <Boundary t={t} resetKey={loc.pathname}>{children}</Boundary>;
}
