import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('ErrorBoundary caught:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div role="alert" style={{ padding: 16 }}>
            <h2>Une erreur est survenue</h2>
            <pre style={{ whiteSpace: 'pre-wrap' }}>{this.state.error.message}</pre>
          </div>
        )
      )
    }
    return this.props.children
  }
}
