export class AppError extends Error {
  status: number
  code: string
  details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export function badRequest(message: string, details?: unknown) {
  return new AppError(400, 'BAD_REQUEST', message, details)
}

export function unauthorized(message = 'Authentication required.') {
  return new AppError(401, 'UNAUTHORIZED', message)
}

export function forbidden(message = 'You do not have access to this action.') {
  return new AppError(403, 'FORBIDDEN', message)
}

export function notFound(message = 'Resource not found.') {
  return new AppError(404, 'NOT_FOUND', message)
}

export function conflict(message: string) {
  return new AppError(409, 'CONFLICT', message)
}

export function unprocessable(message: string, details?: unknown) {
  return new AppError(422, 'UNPROCESSABLE', message, details)
}
