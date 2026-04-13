import { describe, expect, it } from 'vitest';

import { buildInstallProgressViewModel } from '../src/models/model-install-progress';

describe('install progress view model', () => {
  it('builds aggregate progress labels and secondary details', () => {
    const viewModel = buildInstallProgressViewModel({
      details: 'File 2 of 3',
      downloadedBytes: 512,
      isCancelling: false,
      message: 'Downloading vocab.json',
      state: 'downloading',
      totalBytes: 1024,
    });

    expect(viewModel).toEqual({
      bytesLabel: '512 B / 1.0 KiB',
      isCancelling: false,
      primaryLine: 'Downloading vocab.json',
      progressPercent: 50,
      secondaryLine: 'File 2 of 3',
    });
  });

  it('strips directory prefix from download messages', () => {
    const viewModel = buildInstallProgressViewModel({
      details: null,
      downloadedBytes: 0,
      isCancelling: false,
      message: 'Downloading onnx/encoder_model_q4.onnx_data',
      state: 'downloading',
      totalBytes: 1024,
    });

    expect(viewModel.primaryLine).toBe('Downloading encoder_model_q4.onnx_data');
  });

  it('strips directory prefix from verify messages', () => {
    const viewModel = buildInstallProgressViewModel({
      details: null,
      downloadedBytes: 0,
      isCancelling: false,
      message: 'Verifying onnx/encoder_model_q4.onnx_data',
      state: 'verifying',
      totalBytes: 1024,
    });

    expect(viewModel.primaryLine).toBe('Verifying encoder_model_q4.onnx_data');
  });

  it('leaves plain filenames unchanged', () => {
    const viewModel = buildInstallProgressViewModel({
      details: null,
      downloadedBytes: 0,
      isCancelling: false,
      message: 'Downloading ggml-small.en-q5_1.bin',
      state: 'downloading',
      totalBytes: 1024,
    });

    expect(viewModel.primaryLine).toBe('Downloading ggml-small.en-q5_1.bin');
  });

  it('leaves non-artifact messages unchanged', () => {
    const viewModel = buildInstallProgressViewModel({
      details: null,
      downloadedBytes: 0,
      isCancelling: false,
      message: 'Model install queued.',
      state: 'queued',
      totalBytes: 1024,
    });

    expect(viewModel.primaryLine).toBe('Model install queued.');
  });

  it('clamps impossible byte totals instead of surfacing them', () => {
    const viewModel = buildInstallProgressViewModel({
      details: null,
      downloadedBytes: 2048,
      isCancelling: true,
      message: null,
      state: 'verifying',
      totalBytes: 1024,
    });

    expect(viewModel.bytesLabel).toBe('1.0 KiB / 1.0 KiB');
    expect(viewModel.primaryLine).toBe('Verifying download');
    expect(viewModel.progressPercent).toBe(100);
    expect(viewModel.isCancelling).toBe(true);
  });
});
