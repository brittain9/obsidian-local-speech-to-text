export type PluginRuntimeState = 'idle' | 'starting' | 'ready' | 'error';

export class StatusBarController {
  constructor(private readonly element: HTMLElement) {
    this.setState('idle');
  }

  setState(state: PluginRuntimeState, detail?: string): void {
    const label = buildLabel(state, detail);

    this.element.textContent = label;
    this.element.title = label;
  }

  dispose(): void {
    this.element.remove();
  }
}

function buildLabel(state: PluginRuntimeState, detail?: string): string {
  const suffix = detail ? ` (${detail})` : '';

  switch (state) {
    case 'idle':
      return `Local STT: idle${suffix}`;
    case 'starting':
      return `Local STT: starting${suffix}`;
    case 'ready':
      return `Local STT: ready${suffix}`;
    case 'error':
      return `Local STT: error${suffix}`;
  }
}
