// Generic error boundary so a failing widget (e.g. the WebGL map on a machine
// without a GL context) degrades gracefully instead of blanking the whole route.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Rendered when a child throws. */
  fallback: ReactNode;
  /** Optional: called with the error for logging. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
