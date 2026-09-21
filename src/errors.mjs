/** The error type every layer of the server throws: it carries the code and the HTTP status. */
export class UniverseError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'UniverseError';
    this.code = code;
    this.status = status;
  }
}

export function notFound(message = 'This universe does not exist.') {
  return new UniverseError('NOT_FOUND', message, 404);
}
