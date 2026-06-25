import { Component } from 'react';

// Keeps a render-time exception from blanking the whole document. Renders a
// minimal recoverable fallback (with a reload action) instead of a white screen.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ChinaHSR] render error:', error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="center-screen error">
          <h1>Something went wrong</h1>
          <p>{this.state.error?.message || 'An unexpected error occurred.'}</p>
          <button type="button" onClick={() => window.location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}
