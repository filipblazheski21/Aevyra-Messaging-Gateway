export class ImportPreviewError extends Error {
  readonly status: 400 | 413 | 415 | 429 | 503;

  constructor(message: string, status: ImportPreviewError["status"] = 400) {
    super(message);
    this.status = status;
  }
}
