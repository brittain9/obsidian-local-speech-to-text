import { formatBytes } from '../shared/format-utils';
import type { ModelInstallState, ModelInstallUpdateRecord } from './model-management-types';

export interface InstallProgressState
  extends Pick<
    ModelInstallUpdateRecord,
    'details' | 'downloadedBytes' | 'message' | 'state' | 'totalBytes'
  > {
  isCancelling: boolean;
}

interface InstallProgressViewModel {
  bytesLabel: string | null;
  isCancelling: boolean;
  primaryLine: string;
  progressPercent: number | null;
  secondaryLine: string | null;
}

export function buildInstallProgressViewModel(
  state: InstallProgressState,
): InstallProgressViewModel {
  const downloadedBytes =
    state.downloadedBytes !== null && state.totalBytes !== null
      ? Math.min(state.downloadedBytes, state.totalBytes)
      : state.downloadedBytes;
  const bytesLabel =
    downloadedBytes !== null && state.totalBytes !== null
      ? `${formatBytes(downloadedBytes)} / ${formatBytes(state.totalBytes)}`
      : downloadedBytes !== null
        ? formatBytes(downloadedBytes)
        : state.totalBytes !== null
          ? formatBytes(state.totalBytes)
          : null;
  const progressPercent =
    downloadedBytes !== null && state.totalBytes !== null && state.totalBytes > 0
      ? (downloadedBytes / state.totalBytes) * 100
      : null;

  return {
    bytesLabel,
    isCancelling: state.isCancelling,
    primaryLine: resolvePrimaryLine(state.message, state.state),
    progressPercent,
    secondaryLine: normalizeOptionalLine(state.details),
  };
}

export function createInstallProgressElement(state: InstallProgressState): HTMLDivElement {
  const viewModel = buildInstallProgressViewModel(state);
  const root = document.createElement('div');
  const header = document.createElement('div');
  const statusLine = document.createElement('span');

  root.className = 'local-stt-install-progress';
  if (viewModel.isCancelling) {
    root.classList.add('local-stt-install-progress--cancelling');
  }

  header.className = 'local-stt-install-progress__header';
  statusLine.className = 'local-stt-install-progress__status';
  statusLine.textContent = viewModel.primaryLine;
  header.append(statusLine);

  if (viewModel.bytesLabel !== null) {
    const bytesLabel = document.createElement('span');
    bytesLabel.className = 'local-stt-install-progress__bytes';
    bytesLabel.textContent = viewModel.bytesLabel;
    header.append(bytesLabel);
  }

  root.append(header);

  const progressTrack = document.createElement('div');
  const progressFill = document.createElement('div');

  progressTrack.className = 'local-stt-install-progress__track';
  progressTrack.setAttribute('role', 'progressbar');
  progressTrack.setAttribute('aria-label', viewModel.primaryLine);
  progressTrack.setAttribute('aria-valuemin', '0');
  progressTrack.setAttribute('aria-valuemax', '100');
  progressTrack.setAttribute('aria-valuenow', String(Math.round(viewModel.progressPercent ?? 0)));
  progressFill.className = 'local-stt-install-progress__fill';
  progressFill.style.width = `${viewModel.progressPercent ?? 0}%`;
  progressTrack.append(progressFill);
  root.append(progressTrack);

  if (viewModel.secondaryLine !== null) {
    const secondaryLine = document.createElement('div');
    secondaryLine.className = 'local-stt-install-progress__details';
    secondaryLine.textContent = viewModel.secondaryLine;
    root.append(secondaryLine);
  }

  return root;
}

export function updateInstallProgressElement(
  root: HTMLDivElement,
  state: InstallProgressState,
): void {
  const viewModel = buildInstallProgressViewModel(state);

  root.classList.toggle('local-stt-install-progress--cancelling', viewModel.isCancelling);

  const status = root.querySelector('.local-stt-install-progress__status') as HTMLElement | null;
  if (status) status.textContent = viewModel.primaryLine;

  const bytes = root.querySelector('.local-stt-install-progress__bytes') as HTMLElement | null;
  if (bytes) bytes.textContent = viewModel.bytesLabel ?? '';

  const fill = root.querySelector('.local-stt-install-progress__fill') as HTMLDivElement | null;
  if (fill) fill.style.width = `${viewModel.progressPercent ?? 0}%`;

  const track = root.querySelector('.local-stt-install-progress__track') as HTMLElement | null;
  if (track) {
    track.setAttribute('aria-valuenow', String(Math.round(viewModel.progressPercent ?? 0)));
    track.setAttribute('aria-label', viewModel.primaryLine);
  }

  const details = root.querySelector('.local-stt-install-progress__details') as HTMLElement | null;
  if (details) {
    details.textContent = viewModel.secondaryLine ?? '';
    details.style.display = viewModel.secondaryLine !== null ? '' : 'none';
  }
}

function normalizeOptionalLine(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function cleanMessageLine(line: string): string {
  const match = line.match(/^(Downloading|Verifying)\s+(.+)$/);
  if (match === null) return line;
  const verb = match[1] as string;
  const filename = match[2] as string;
  const lastSlash = filename.lastIndexOf('/');
  return lastSlash === -1 ? line : `${verb} ${filename.slice(lastSlash + 1)}`;
}

function resolvePrimaryLine(message: string | null, state: ModelInstallState): string {
  const normalizedMessage = normalizeOptionalLine(message);
  if (normalizedMessage !== null) {
    return cleanMessageLine(normalizedMessage);
  }

  switch (state) {
    case 'queued':
      return 'Preparing install';
    case 'downloading':
      return 'Downloading';
    case 'verifying':
      return 'Verifying download';
    case 'probing':
      return 'Validating model';
    case 'completed':
      return 'Model installed';
    case 'cancelled':
      return 'Model install cancelled';
    case 'failed':
      return 'Model install failed';
  }
}
